import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject } from '@nestjs/common';
import { Job } from 'bullmq';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import { Logger } from 'winston';
import { EncryptionService } from '../common/encryption/encryption.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { RealtimePublisher } from '../common/realtime/realtime.publisher';
import {
  CommentKind,
  CommentSyncStatus,
  DiffSide,
  IntegrationState,
  Provider,
} from '../generated/prisma/enums';
import { providerBody } from '../modules/comments/comment-marker';
import { GithubAppService } from '../modules/integrations/github-app.service';
import {
  GitlabApiService,
  type GitlabNotePosition,
} from '../modules/integrations/gitlab-api.service';
import { ProviderCommentError } from '../modules/integrations/provider-comment-error';
import {
  COMMENT_SYNC_QUEUE_NAME,
  CommentSyncJobPayload,
} from './comment-sync-queue.constants';

// A credential that cannot act on the repository right now.
const UNUSABLE_STATES: IntegrationState[] = [
  IntegrationState.TOKEN_EXPIRED,
  IntegrationState.INVALID,
  IntegrationState.UNINSTALLED,
  IntegrationState.SUSPENDED,
  IntegrationState.PENDING_APPROVAL,
];

interface ProviderIds {
  providerCommentId: string;
  providerThreadId: string | null;
}

// Copies a comment written in Critiq to GitHub/GitLab (v1.5.2), as Critiq's
// App or the org token, with the author named and an anti-echo marker in
// the text (comment-marker.ts). Runs only in the worker.
@Processor(COMMENT_SYNC_QUEUE_NAME)
export class CommentSyncProcessor extends WorkerHost {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryptionService: EncryptionService,
    private readonly githubAppService: GithubAppService,
    private readonly gitlabApiService: GitlabApiService,
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
    private readonly realtime: RealtimePublisher,
  ) {
    super();
  }

  async process(job: Job<CommentSyncJobPayload>): Promise<void> {
    const comment = await this.prisma.pullComment.findUnique({
      where: { id: job.data.commentId },
      include: {
        author: { select: { name: true, email: true } },
        parent: {
          select: {
            body: true,
            providerCommentId: true,
            providerThreadId: true,
          },
        },
        pullRequest: {
          select: {
            externalId: true,
            repository: {
              select: {
                path: true,
                externalId: true,
                integration: {
                  select: {
                    source: true,
                    state: true,
                    installationId: true,
                    instanceUrl: true,
                    encryptedToken: true,
                  },
                },
              },
            },
          },
        },
      },
    });
    if (!comment || comment.syncStatus !== CommentSyncStatus.PENDING) {
      return;
    }
    const log = {
      orgId: comment.organizationId,
      pullId: comment.pullId,
      commentId: comment.id,
      attemptsMade: job.attemptsMade,
    };

    let ids: ProviderIds;
    try {
      const { repository } = comment.pullRequest;
      if (UNUSABLE_STATES.includes(repository.integration.state)) {
        throw new ProviderCommentError(
          'insufficient_permission',
          false,
          `integration ${repository.integration.state}`,
        );
      }
      const text = providerBody(
        comment.author?.name ?? comment.author?.email ?? 'A Critiq user',
        comment.body,
        comment.id,
        // GitHub's PR conversation has no threads: a reply quotes its root.
        repository.integration.source === Provider.GITHUB &&
          comment.kind === CommentKind.GENERAL &&
          comment.parent
          ? comment.parent.body
          : undefined,
      );
      ids =
        repository.integration.source === Provider.GITHUB
          ? await this.sendToGithub(comment, repository, text)
          : await this.sendToGitlab(comment, repository, text);
    } catch (error) {
      const failure =
        error instanceof ProviderCommentError
          ? error
          : new ProviderCommentError(
              'unknown',
              true,
              error instanceof Error ? error.message.slice(0, 200) : undefined,
            );
      const lastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      if (failure.retryable && !lastAttempt) {
        this.logger.warn('comment.sync_retrying', {
          ...log,
          code: failure.code,
          detail: failure.detail,
        });
        throw failure;
      }
      const { count } = await this.prisma.pullComment.updateMany({
        where: { id: comment.id, syncStatus: CommentSyncStatus.PENDING },
        data: { syncStatus: CommentSyncStatus.FAILED, syncError: failure.code },
      });
      if (count > 0) {
        await this.realtime.commentChanged(comment.id, 'sync_failed');
      }
      this.logger.warn('comment.sync_failed', {
        ...log,
        code: failure.code,
        detail: failure.detail,
      });
      return;
    }

    const { count } = await this.prisma.pullComment.updateMany({
      where: { id: comment.id, syncStatus: CommentSyncStatus.PENDING },
      data: {
        syncStatus: CommentSyncStatus.SYNCED,
        syncError: null,
        providerCommentId: ids.providerCommentId,
        providerThreadId: ids.providerThreadId,
      },
    });
    if (count > 0) {
      await this.realtime.commentChanged(comment.id, 'synced');
    }
    this.logger.info('comment.synced', log);
  }

  private async sendToGithub(
    comment: {
      kind: CommentKind;
      path: string | null;
      line: number | null;
      side: DiffSide | null;
      headSha: string | null;
      parent: { providerThreadId: string | null } | null;
      pullRequest: { externalId: string };
    },
    repository: {
      path: string;
      integration: { installationId: string | null };
    },
    text: string,
  ): Promise<ProviderIds> {
    const installationId = repository.integration.installationId ?? '';
    const [owner, repo] = repository.path.split('/');
    const number = comment.pullRequest.externalId;

    if (comment.kind === CommentKind.GENERAL) {
      const { id } = await this.githubAppService.createIssueComment(
        installationId,
        owner,
        repo,
        number,
        text,
      );
      return {
        providerCommentId: `github-issue:${id}`,
        providerThreadId: null,
      };
    }
    if (comment.parent) {
      const rootId = numericId(
        comment.parent.providerThreadId,
        'github-review:',
      );
      const { id } = await this.githubAppService.replyToReviewComment(
        installationId,
        owner,
        repo,
        number,
        rootId,
        text,
      );
      return {
        providerCommentId: `github-review:${id}`,
        providerThreadId: comment.parent.providerThreadId,
      };
    }
    const { id } = await this.githubAppService.createReviewComment(
      installationId,
      owner,
      repo,
      number,
      {
        body: text,
        commitId: comment.headSha ?? '',
        path: comment.path ?? '',
        line: comment.line ?? 0,
        side: comment.side === DiffSide.OLD ? 'LEFT' : 'RIGHT',
      },
    );
    return {
      providerCommentId: `github-review:${id}`,
      providerThreadId: `github-review:${id}`,
    };
  }

  private async sendToGitlab(
    comment: {
      kind: CommentKind;
      path: string | null;
      line: number | null;
      side: DiffSide | null;
      parent: { providerThreadId: string | null } | null;
      pullRequest: { externalId: string };
    },
    repository: {
      externalId: string;
      integration: {
        instanceUrl: string | null;
        encryptedToken: string | null;
      };
    },
    text: string,
  ): Promise<ProviderIds> {
    const instanceUrl = repository.integration.instanceUrl ?? '';
    const token = repository.integration.encryptedToken
      ? this.encryptionService.decrypt(repository.integration.encryptedToken)
      : '';
    const projectId = repository.externalId;
    const iid = comment.pullRequest.externalId;

    if (comment.parent) {
      const threadId = comment.parent.providerThreadId;
      if (!threadId?.startsWith('gitlab-discussion:')) {
        throw new ProviderCommentError('parent_not_synced', true);
      }
      const { noteId } = await this.gitlabApiService.addDiscussionNote(
        instanceUrl,
        token,
        projectId,
        iid,
        threadId.slice('gitlab-discussion:'.length),
        text,
      );
      return {
        providerCommentId: `gitlab-note:${noteId}`,
        providerThreadId: threadId,
      };
    }

    let position: GitlabNotePosition | undefined;
    if (comment.kind === CommentKind.INLINE) {
      const refs = await this.gitlabApiService.fetchMergeRequestDiffRefs(
        instanceUrl,
        token,
        projectId,
        iid,
      );
      position = {
        ...refs,
        position_type: 'text' as const,
        old_path: comment.path ?? '',
        new_path: comment.path ?? '',
        ...(comment.side === DiffSide.OLD
          ? { old_line: comment.line ?? 0 }
          : { new_line: comment.line ?? 0 }),
      };
    }
    const { discussionId, noteId } =
      await this.gitlabApiService.createDiscussion(
        instanceUrl,
        token,
        projectId,
        iid,
        text,
        position,
      );
    return {
      providerCommentId: `gitlab-note:${noteId}`,
      providerThreadId: `gitlab-discussion:${discussionId}`,
    };
  }
}

// The provider's numeric id out of a prefixed Critiq one. A reply whose
// thread has no provider id yet waits for it (retried).
function numericId(prefixed: string | null, prefix: string): number {
  const id = prefixed?.startsWith(prefix)
    ? Number(prefixed.slice(prefix.length))
    : NaN;
  if (!Number.isInteger(id)) {
    throw new ProviderCommentError('parent_not_synced', true);
  }
  return id;
}
