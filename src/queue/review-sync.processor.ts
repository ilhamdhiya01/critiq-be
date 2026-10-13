import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject } from '@nestjs/common';
import { Job } from 'bullmq';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import { Logger } from 'winston';
import { EncryptionService } from '../common/encryption/encryption.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { RealtimePublisher } from '../common/realtime/realtime.publisher';
import {
  IntegrationState,
  Provider,
  ReviewDecision,
  ReviewSyncStatus,
} from '../generated/prisma/enums';
import { GithubAppService } from '../modules/integrations/github-app.service';
import { GitlabApiService } from '../modules/integrations/gitlab-api.service';
import { ProviderReviewError } from '../modules/integrations/provider-review-error';
import {
  REVIEW_SYNC_QUEUE_NAME,
  ReviewSyncJobPayload,
} from './review-sync-queue.constants';

// A credential that cannot act on the repository right now.
const UNUSABLE_STATES: IntegrationState[] = [
  IntegrationState.TOKEN_EXPIRED,
  IntegrationState.INVALID,
  IntegrationState.UNINSTALLED,
  IntegrationState.SUSPENDED,
  IntegrationState.PENDING_APPROVAL,
];

interface ReviewToSync {
  id: string;
  organizationId: string;
  pullId: string;
  headSha: string;
  decision: ReviewDecision;
  body: string | null;
  reviewerName: string;
  pull: { externalId: string };
  repository: { path: string; externalId: string };
  integration: {
    source: Provider;
    state: IntegrationState;
    installationId: string | null;
    instanceUrl: string | null;
    encryptedToken: string | null;
  };
}

// Copies a reviewer's decision to GitHub/GitLab (v1.5.2), as Critiq's App or
// the org token — the reviewer is named in the text. Runs only in the
// worker. The decision in Critiq is already recorded; this only moves its
// syncStatus from PENDING to SYNCED or FAILED.
@Processor(REVIEW_SYNC_QUEUE_NAME)
export class ReviewSyncProcessor extends WorkerHost {
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

  async process(job: Job<ReviewSyncJobPayload>): Promise<void> {
    const review = await this.load(job.data.reviewId);
    if (!review) {
      return;
    }
    const log = {
      orgId: review.organizationId,
      pullId: review.pullId,
      reviewId: review.id,
      attemptsMade: job.attemptsMade,
    };

    try {
      await this.send(review);
    } catch (error) {
      const failure =
        error instanceof ProviderReviewError
          ? error
          : new ProviderReviewError(
              'unknown',
              true,
              error instanceof Error ? error.message.slice(0, 200) : undefined,
            );
      const lastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      if (failure.retryable && !lastAttempt) {
        this.logger.warn('review.sync_retrying', {
          ...log,
          code: failure.code,
          detail: failure.detail,
        });
        throw failure;
      }
      const { count } = await this.prisma.pullReview.updateMany({
        where: { id: review.id, syncStatus: ReviewSyncStatus.PENDING },
        data: { syncStatus: ReviewSyncStatus.FAILED, syncError: failure.code },
      });
      if (count > 0) {
        await this.realtime.reviewChanged(review.id);
      }
      this.logger.warn('review.sync_failed', {
        ...log,
        code: failure.code,
        detail: failure.detail,
      });
      return;
    }

    const { count } = await this.prisma.pullReview.updateMany({
      where: { id: review.id, syncStatus: ReviewSyncStatus.PENDING },
      data: {
        syncStatus: ReviewSyncStatus.SYNCED,
        syncError: null,
        syncedAt: new Date(),
      },
    });
    if (count > 0) {
      await this.realtime.reviewChanged(review.id);
    }
    this.logger.info('review.synced', log);
  }

  // Null when there is nothing to send: the review is gone, or its copy is
  // no longer pending (sent already, or failed and waiting for a retry).
  private async load(reviewId: string): Promise<ReviewToSync | null> {
    const review = await this.prisma.pullReview.findUnique({
      where: { id: reviewId },
      include: {
        reviewer: { select: { name: true, email: true } },
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
    if (!review || review.syncStatus !== ReviewSyncStatus.PENDING) {
      return null;
    }
    const { repository } = review.pullRequest;
    return {
      id: review.id,
      organizationId: review.organizationId,
      pullId: review.pullId,
      headSha: review.headSha,
      decision: review.decision,
      body: review.body,
      reviewerName:
        review.reviewer?.name ?? review.reviewer?.email ?? 'a Critiq reviewer',
      pull: { externalId: review.pullRequest.externalId },
      repository: { path: repository.path, externalId: repository.externalId },
      integration: repository.integration,
    };
  }

  private async send(review: ReviewToSync): Promise<void> {
    const { integration } = review;
    if (UNUSABLE_STATES.includes(integration.state)) {
      throw new ProviderReviewError(
        'insufficient_permission',
        false,
        `integration ${integration.state}`,
      );
    }
    const approve = review.decision === ReviewDecision.APPROVE;
    const text = approve
      ? `${review.body ? `${review.body}\n\n` : ''}Approved by ${review.reviewerName} via Critiq.`
      : `Changes requested by ${review.reviewerName} via Critiq:\n\n${review.body ?? ''}`;

    if (integration.source === Provider.GITHUB) {
      const [owner, repo] = review.repository.path.split('/');
      await this.githubAppService.submitPullReview(
        integration.installationId ?? '',
        owner,
        repo,
        review.pull.externalId,
        {
          commitId: review.headSha,
          event: approve ? 'APPROVE' : 'REQUEST_CHANGES',
          body: text,
        },
      );
      return;
    }

    const instanceUrl = integration.instanceUrl ?? '';
    const token = integration.encryptedToken
      ? this.encryptionService.decrypt(integration.encryptedToken)
      : '';
    const projectId = review.repository.externalId;
    const iid = review.pull.externalId;
    if (approve) {
      await this.gitlabApiService.approveMergeRequest(
        instanceUrl,
        token,
        projectId,
        iid,
        review.headSha,
      );
      // The approval is what counts on GitLab; the note only names the
      // reviewer, so losing it does not undo a done approval.
      await this.gitlabApiService
        .createMergeRequestNote(instanceUrl, token, projectId, iid, text)
        .catch((error: unknown) =>
          this.logger.warn('review.sync_note_failed', {
            reviewId: review.id,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      return;
    }
    // GitLab has no "request changes" verb: withdraw the approval and leave
    // the reason as a note — the note is the substance here.
    await this.gitlabApiService.unapproveMergeRequest(
      instanceUrl,
      token,
      projectId,
      iid,
    );
    await this.gitlabApiService.createMergeRequestNote(
      instanceUrl,
      token,
      projectId,
      iid,
      text,
    );
  }
}
