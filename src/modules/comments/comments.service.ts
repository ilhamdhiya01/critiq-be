import { InjectQueue } from '@nestjs/bullmq';
import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Queue } from 'bullmq';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import { Logger } from 'winston';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  CommentKind,
  CommentOrigin,
  CommentSyncStatus,
  DiffSide,
} from '../../generated/prisma/enums';
import {
  buildCommentSyncJobId,
  COMMENT_SYNC_BACKOFF,
  COMMENT_SYNC_JOB_ATTEMPTS,
  COMMENT_SYNC_QUEUE_NAME,
  CommentSyncJobPayload,
} from '../../queue/comment-sync-queue.constants';
import {
  COMMENT_INCLUDE,
  CommentDto,
  CommentRow,
  CommentThreadDto,
  toCommentDto,
  toThreads,
} from './dto/comment.dto';
import { CreateCommentDto } from './dto/create-comment.dto';

// Comments written in Critiq (v1.5.2): stored, then copied to GitHub/GitLab
// by the comment-sync queue. Comments written on the provider arrive through
// CommentIngestService instead.
@Injectable()
export class CommentsService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(COMMENT_SYNC_QUEUE_NAME)
    private readonly commentSyncQueue: Queue<CommentSyncJobPayload>,
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
  ) {}

  async list(
    organizationId: string,
    repositoryId: string,
    pullId: string,
  ): Promise<{ threads: CommentThreadDto[] }> {
    const pull = await this.findPullOrThrow(
      organizationId,
      repositoryId,
      pullId,
    );
    const rows = await this.prisma.pullComment.findMany({
      where: { organizationId, pullId },
      include: COMMENT_INCLUDE,
    });
    return { threads: toThreads(rows, pull.headSha) };
  }

  async create(
    organizationId: string,
    repositoryId: string,
    pullId: string,
    actorUserId: string,
    dto: CreateCommentDto,
  ): Promise<CommentDto> {
    const pull = await this.findPullOrThrow(
      organizationId,
      repositoryId,
      pullId,
    );
    const body = dto.body.trim();
    if (!body) {
      throw new UnprocessableEntityException({
        field: 'body',
        message: 'body_required',
      });
    }

    let placement: {
      kind: CommentKind;
      parentId: string | null;
      path: string | null;
      line: number | null;
      side: DiffSide | null;
      headSha: string | null;
    };
    if (dto.parentId) {
      // A reply takes its thread's place; it never brings one of its own.
      const parent = dto.inline
        ? null
        : await this.prisma.pullComment.findUnique({
            where: { id: dto.parentId },
          });
      if (!parent || parent.pullId !== pullId) {
        throw new UnprocessableEntityException({
          field: 'parentId',
          message: 'invalid_parent',
        });
      }
      const rootId = parent.parentId ?? parent.id;
      const root =
        rootId === parent.id
          ? parent
          : await this.prisma.pullComment.findUniqueOrThrow({
              where: { id: rootId },
            });
      placement = {
        kind: root.kind,
        parentId: root.id,
        path: root.path,
        line: root.line,
        side: root.side,
        headSha: root.headSha,
      };
    } else if (dto.inline) {
      // An inline comment is placed on the diff the author is looking at;
      // a line of an older commit may no longer exist on the provider.
      if (!pull.headSha || dto.inline.headSha !== pull.headSha) {
        throw new ConflictException({
          field: 'inline.headSha',
          message: 'head_changed',
        });
      }
      placement = {
        kind: CommentKind.INLINE,
        parentId: null,
        path: dto.inline.path,
        line: dto.inline.line,
        side: dto.inline.side === 'old' ? DiffSide.OLD : DiffSide.NEW,
        headSha: pull.headSha,
      };
    } else {
      placement = {
        kind: CommentKind.GENERAL,
        parentId: null,
        path: null,
        line: null,
        side: null,
        headSha: null,
      };
    }

    const comment = await this.prisma.pullComment.create({
      data: {
        organizationId,
        pullId,
        origin: CommentOrigin.CRITIQ,
        authorId: actorUserId,
        body,
        syncStatus: CommentSyncStatus.PENDING,
        ...placement,
      },
      include: COMMENT_INCLUDE,
    });
    this.logger.info('comment.created', {
      orgId: organizationId,
      pullId,
      commentId: comment.id,
      by: actorUserId,
      kind: comment.kind,
      reply: comment.parentId !== null,
    });
    return toCommentDto(await this.enqueueSync(comment));
  }

  async retrySync(
    organizationId: string,
    repositoryId: string,
    pullId: string,
    commentId: string,
  ): Promise<CommentDto> {
    await this.findPullOrThrow(organizationId, repositoryId, pullId);
    const comment = await this.prisma.pullComment.findUnique({
      where: { id: commentId },
      include: COMMENT_INCLUDE,
    });
    if (
      !comment ||
      comment.organizationId !== organizationId ||
      comment.pullId !== pullId ||
      comment.origin !== CommentOrigin.CRITIQ
    ) {
      throw new NotFoundException('Comment not found.');
    }
    if (comment.syncStatus === CommentSyncStatus.SYNCED) {
      throw new ConflictException({
        field: 'commentId',
        message: 'already_synced',
      });
    }
    const { count } = await this.prisma.pullComment.updateMany({
      where: { id: commentId, syncStatus: CommentSyncStatus.FAILED },
      data: { syncStatus: CommentSyncStatus.PENDING, syncError: null },
    });
    if (count === 0) {
      throw new ConflictException({
        field: 'commentId',
        message: 'sync_in_progress',
      });
    }
    return toCommentDto(
      await this.enqueueSync({
        ...comment,
        syncStatus: CommentSyncStatus.PENDING,
        syncError: null,
      }),
    );
  }

  // The comment stays even when the queue cannot take the job: its copy is
  // marked failed, and the author can send it again.
  private async enqueueSync(comment: CommentRow): Promise<CommentRow> {
    try {
      await this.commentSyncQueue.add(
        'sync',
        { commentId: comment.id },
        {
          jobId: buildCommentSyncJobId(comment.id, Date.now()),
          attempts: COMMENT_SYNC_JOB_ATTEMPTS,
          backoff: COMMENT_SYNC_BACKOFF,
          removeOnComplete: true,
          removeOnFail: 100,
        },
      );
      return comment;
    } catch (error) {
      this.logger.error('comment.sync_enqueue_failed', {
        commentId: comment.id,
        error: error instanceof Error ? error.message : String(error),
      });
      await this.prisma.pullComment.update({
        where: { id: comment.id },
        data: { syncStatus: CommentSyncStatus.FAILED, syncError: 'unknown' },
      });
      return {
        ...comment,
        syncStatus: CommentSyncStatus.FAILED,
        syncError: 'unknown',
      };
    }
  }

  // Check-after-fetch: another org's or repo's PR is indistinguishable from
  // a missing one.
  private async findPullOrThrow(
    organizationId: string,
    repositoryId: string,
    pullId: string,
  ) {
    const pull = await this.prisma.pullRequest.findUnique({
      where: { id: pullId },
      select: { organizationId: true, repositoryId: true, headSha: true },
    });
    if (
      !pull ||
      pull.organizationId !== organizationId ||
      pull.repositoryId !== repositoryId
    ) {
      throw new NotFoundException('Pull request not found.');
    }
    return pull;
  }
}
