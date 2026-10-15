import { Inject, Injectable } from '@nestjs/common';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import { Logger } from 'winston';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RealtimePublisher } from '../../common/realtime/realtime.publisher';
import type { CommentChange } from '../../common/realtime/realtime-event.types';
import {
  CommentKind,
  CommentOrigin,
  DiffSide,
  Provider,
} from '../../generated/prisma/enums';
import { markerOf, stripCritiqFraming } from './comment-marker';

// A comment as a provider webhook reports it, already parsed and verified.
export interface InboundComment {
  provider: Provider;
  // The provider's repository / project id and PR / MR number.
  repositoryExternalId: string;
  pullExternalId: string;
  action: 'created' | 'edited' | 'deleted';
  // Prefixed: `github-issue:`, `github-review:`, `gitlab-note:`.
  providerCommentId: string;
  // GitHub: the review comment this replies to (`github-review:<id>`);
  // GitLab: the discussion (`gitlab-discussion:<id>`). Null otherwise.
  providerThreadKey: string | null;
  kind: CommentKind;
  path: string | null;
  line: number | null;
  side: DiffSide | null;
  headSha: string | null;
  body: string;
  author: string;
  avatarUrl: string | null;
  createdAt: Date;
}

export type IngestOutcome =
  'created' | 'updated' | 'deleted' | 'linked' | 'ignored';

// Comments written on GitHub/GitLab (v1.5.2), from the webhook — the other
// half of the two-way sync. No provider call here: the webhook stays fast.
// Isolation: the repository is resolved by the provider's own id, and every
// read and write below is scoped to that repository's PR.
@Injectable()
export class CommentIngestService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
    private readonly realtime: RealtimePublisher,
  ) {}

  async ingest(event: InboundComment): Promise<IngestOutcome> {
    const repository = await this.prisma.repository.findFirst({
      where: {
        provider: event.provider,
        externalId: event.repositoryExternalId,
      },
      select: { id: true, organizationId: true },
    });
    if (!repository) {
      return 'ignored';
    }
    // Only PRs Critiq tracks (in scan scope) have a row.
    const pull = await this.prisma.pullRequest.findUnique({
      where: {
        repositoryId_externalId: {
          repositoryId: repository.id,
          externalId: event.pullExternalId,
        },
      },
      select: { id: true },
    });
    if (!pull) {
      return 'ignored';
    }
    const log = {
      orgId: repository.organizationId,
      pullId: pull.id,
      providerCommentId: event.providerCommentId,
      action: event.action,
    };
    const announce = (commentId: string, change: CommentChange) =>
      this.realtime.publish({
        type: 'comment.updated',
        orgId: repository.organizationId,
        repoId: repository.id,
        pullId: pull.id,
        commentId,
        change,
      });

    const existing = await this.prisma.pullComment.findUnique({
      where: {
        pullId_providerCommentId: {
          pullId: pull.id,
          providerCommentId: event.providerCommentId,
        },
      },
    });

    if (event.action === 'deleted') {
      if (!existing) {
        return 'ignored';
      }
      await this.prisma.pullComment.update({
        where: { id: existing.id },
        data: { deletedAt: new Date() },
      });
      await announce(existing.id, 'deleted');
      this.logger.info('comment.ingested', { ...log, outcome: 'deleted' });
      return 'deleted';
    }

    if (existing) {
      // A comment written in Critiq and edited on the provider keeps its
      // Critiq author; only the text changes.
      const body =
        existing.origin === CommentOrigin.CRITIQ
          ? stripCritiqFraming(event.body)
          : event.body;
      if (body === existing.body) {
        return 'ignored';
      }
      await this.prisma.pullComment.update({
        where: { id: existing.id },
        data: { body, editedAt: new Date() },
      });
      await announce(existing.id, 'edited');
      this.logger.info('comment.ingested', { ...log, outcome: 'updated' });
      return 'updated';
    }

    // Our own comment coming back: link it to the row it came from. The
    // comment-sync job may not have stored the provider id yet.
    const ownId = markerOf(event.body);
    if (ownId) {
      const own = await this.prisma.pullComment.findUnique({
        where: { id: ownId },
        select: { id: true, pullId: true, providerCommentId: true },
      });
      if (own && own.pullId === pull.id && own.providerCommentId === null) {
        await this.prisma.pullComment.update({
          where: { id: own.id },
          data: { providerCommentId: event.providerCommentId },
        });
        return 'linked';
      }
      return 'ignored';
    }

    const thread = await this.resolveThread(pull.id, event);
    const created = await this.prisma.pullComment.create({
      data: {
        organizationId: repository.organizationId,
        pullId: pull.id,
        origin:
          event.provider === Provider.GITHUB
            ? CommentOrigin.GITHUB
            : CommentOrigin.GITLAB,
        providerAuthor: event.author,
        providerAuthorAvatarUrl: event.avatarUrl,
        body: event.body,
        providerCommentId: event.providerCommentId,
        createdAt: event.createdAt,
        ...thread,
      },
      select: { id: true },
    });
    await announce(created.id, 'created');
    this.logger.info('comment.ingested', { ...log, outcome: 'created' });
    return 'created';
  }

  // Where a new provider comment goes: into the thread it replies to (which
  // fixes its kind and position), or as a new thread of its own.
  private async resolveThread(pullId: string, event: InboundComment) {
    const own = {
      parentId: null as string | null,
      kind: event.kind,
      path: event.path,
      line: event.line,
      side: event.side,
      headSha: event.headSha,
      providerThreadId:
        event.providerThreadKey ??
        (event.kind === CommentKind.INLINE ? event.providerCommentId : null),
    };
    if (!event.providerThreadKey) {
      return own;
    }
    // GitHub names the comment replied to; GitLab names the discussion.
    const anchor = await this.prisma.pullComment.findFirst({
      where: {
        pullId,
        OR: [
          { providerCommentId: event.providerThreadKey },
          { providerThreadId: event.providerThreadKey },
        ],
      },
      orderBy: { createdAt: 'asc' },
    });
    if (!anchor) {
      return own;
    }
    const rootId = anchor.parentId ?? anchor.id;
    const root =
      rootId === anchor.id
        ? anchor
        : await this.prisma.pullComment.findUniqueOrThrow({
            where: { id: rootId },
          });
    return {
      parentId: root.id,
      kind: root.kind,
      path: root.path,
      line: root.line,
      side: root.side,
      headSha: root.headSha,
      providerThreadId: root.providerThreadId ?? event.providerThreadKey,
    };
  }
}
