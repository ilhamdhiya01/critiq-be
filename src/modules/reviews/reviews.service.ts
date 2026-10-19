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
import { RealtimePublisher } from '../../common/realtime/realtime.publisher';
import {
  AiScanStatus,
  PullRequestState,
  ReviewDecision,
  ReviewPolicy,
  ReviewSyncStatus,
  ScanStatus,
} from '../../generated/prisma/enums';
import {
  buildReviewSyncJobId,
  REVIEW_SYNC_BACKOFF,
  REVIEW_SYNC_JOB_ATTEMPTS,
  REVIEW_SYNC_QUEUE_NAME,
  ReviewSyncJobPayload,
} from '../../queue/review-sync-queue.constants';
import { REVIEW_INCLUDE, ReviewDto, toReviewDto } from './dto/review.dto';
import { SubmitReviewDto } from './dto/submit-review.dto';

const AI_DONE: AiScanStatus[] = [AiScanStatus.DONE, AiScanStatus.CACHED];

// "AI-assisted" (dashboard), snapshotted on the review: the AI review of the
// commit being decided on was done at that moment.
export function aiReviewedHead(pull: {
  headSha: string | null;
  latestScan: {
    status: ScanStatus;
    headSha: string;
    aiStatus: AiScanStatus | null;
  } | null;
}): boolean {
  const scan = pull.latestScan;
  return (
    scan !== null &&
    scan.status === ScanStatus.DONE &&
    scan.headSha === pull.headSha &&
    scan.aiStatus !== null &&
    AI_DONE.includes(scan.aiStatus)
  );
}

// v1.5.2 human-in-the-loop: a reviewer's decision, recorded in Critiq and
// copied to GitHub/GitLab by the review-sync queue. Only a person calling
// this endpoint ever creates one — no scan or AI job does.
@Injectable()
export class ReviewsService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(REVIEW_SYNC_QUEUE_NAME)
    private readonly reviewSyncQueue: Queue<ReviewSyncJobPayload>,
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
    private readonly realtime: RealtimePublisher,
  ) {}

  async submit(
    organizationId: string,
    repositoryId: string,
    pullId: string,
    actorUserId: string,
    dto: SubmitReviewDto,
  ): Promise<ReviewDto> {
    const pull = await this.findPullOrThrow(
      organizationId,
      repositoryId,
      pullId,
    );
    if (pull.state !== PullRequestState.OPEN) {
      throw new UnprocessableEntityException({
        field: 'pullId',
        message: 'pull_not_open',
      });
    }
    // The decision is for the commit the reviewer saw — never for one
    // pushed after the page loaded.
    if (!pull.headSha || dto.headSha !== pull.headSha) {
      throw new ConflictException({
        field: 'headSha',
        message: 'head_changed',
      });
    }

    const decision =
      dto.decision === 'approve'
        ? ReviewDecision.APPROVE
        : ReviewDecision.REQUEST_CHANGES;
    // Repeating one's own latest decision on the same commit adds nothing
    // — and would post a second bot review on the provider. Changing one's
    // mind, a newer commit or another reviewer are all fine.
    const mine = await this.prisma.pullReview.findFirst({
      where: { pullId, reviewerId: actorUserId, headSha: pull.headSha },
      orderBy: { createdAt: 'desc' },
      select: { decision: true },
    });
    if (mine?.decision === decision) {
      throw new ConflictException({
        field: 'decision',
        message: 'already_reviewed',
      });
    }
    const body = dto.body?.trim() || null;
    if (decision === ReviewDecision.REQUEST_CHANGES && !body) {
      throw new UnprocessableEntityException({
        field: 'body',
        message: 'body_required',
      });
    }
    if (
      decision === ReviewDecision.APPROVE &&
      pull.effectivePolicy === ReviewPolicy.REQUIRE_BOTH
    ) {
      this.assertRequireBoth(pull, dto.manualConfirmation === true);
    }

    // The guard checked the role; it is read again here to be recorded.
    const membership = await this.prisma.membership.findUniqueOrThrow({
      where: {
        userId_organizationId: { userId: actorUserId, organizationId },
      },
      select: { role: true },
    });

    const review = await this.prisma.pullReview.create({
      data: {
        organizationId,
        pullId,
        headSha: pull.headSha,
        decision,
        body,
        reviewerId: actorUserId,
        reviewerRole: membership.role,
        effectivePolicy: pull.effectivePolicy,
        manualConfirmation: dto.manualConfirmation === true,
        aiAssisted: aiReviewedHead(pull),
      },
      include: REVIEW_INCLUDE,
    });

    // TODO(audit log model): persisted row once the table exists.
    this.logger.info('audit.review.submitted', {
      orgId: organizationId,
      repoId: repositoryId,
      pullId,
      reviewId: review.id,
      by: actorUserId,
      role: membership.role,
      decision,
      headSha: pull.headSha,
      effectivePolicy: pull.effectivePolicy,
      manualConfirmation: review.manualConfirmation,
    });

    return toReviewDto(await this.enqueueSync(review.id, review), pull.headSha);
  }

  async list(
    organizationId: string,
    repositoryId: string,
    pullId: string,
  ): Promise<ReviewDto[]> {
    const pull = await this.findPullOrThrow(
      organizationId,
      repositoryId,
      pullId,
    );
    const reviews = await this.prisma.pullReview.findMany({
      where: { organizationId, pullId },
      orderBy: { createdAt: 'desc' },
      include: REVIEW_INCLUDE,
    });
    return reviews.map((review) => toReviewDto(review, pull.headSha));
  }

  // Sends a failed copy again. A decision on an older commit is not resent:
  // the reviewer looks at the new head and decides again.
  async retrySync(
    organizationId: string,
    repositoryId: string,
    pullId: string,
    reviewId: string,
  ): Promise<ReviewDto> {
    const pull = await this.findPullOrThrow(
      organizationId,
      repositoryId,
      pullId,
    );
    const review = await this.prisma.pullReview.findUnique({
      where: { id: reviewId },
      include: REVIEW_INCLUDE,
    });
    if (
      !review ||
      review.organizationId !== organizationId ||
      review.pullId !== pullId
    ) {
      throw new NotFoundException('Review not found.');
    }
    if (review.syncStatus === ReviewSyncStatus.SYNCED) {
      throw new ConflictException({
        field: 'reviewId',
        message: 'already_synced',
      });
    }
    if (review.syncStatus === ReviewSyncStatus.PENDING) {
      throw new ConflictException({
        field: 'reviewId',
        message: 'sync_in_progress',
      });
    }
    if (review.headSha !== pull.headSha) {
      throw new ConflictException({
        field: 'reviewId',
        message: 'head_changed',
      });
    }

    const { count } = await this.prisma.pullReview.updateMany({
      where: { id: reviewId, syncStatus: ReviewSyncStatus.FAILED },
      data: { syncStatus: ReviewSyncStatus.PENDING, syncError: null },
    });
    if (count === 0) {
      throw new ConflictException({
        field: 'reviewId',
        message: 'sync_in_progress',
      });
    }
    this.logger.info('review.sync_retry_requested', {
      orgId: organizationId,
      pullId,
      reviewId,
    });
    return toReviewDto(
      await this.enqueueSync(reviewId, {
        ...review,
        syncStatus: ReviewSyncStatus.PENDING,
        syncError: null,
      }),
      pull.headSha,
    );
  }

  // Require both (PRD §7): an explicit manual confirmation AND a finished AI
  // review of this very commit.
  private assertRequireBoth(
    pull: {
      headSha: string | null;
      latestScan: {
        status: ScanStatus;
        headSha: string;
        aiStatus: AiScanStatus | null;
      } | null;
    },
    manualConfirmation: boolean,
  ): void {
    if (!manualConfirmation) {
      throw new UnprocessableEntityException({
        field: 'manualConfirmation',
        message: 'manual_confirmation_required',
      });
    }
    const scan = pull.latestScan;
    if (
      !scan ||
      scan.status !== ScanStatus.DONE ||
      scan.headSha !== pull.headSha
    ) {
      throw new UnprocessableEntityException({
        field: 'pullId',
        message: 'scan_required',
      });
    }
    if (!scan.aiStatus || !AI_DONE.includes(scan.aiStatus)) {
      throw new UnprocessableEntityException({
        field: 'pullId',
        message: 'ai_analysis_required',
      });
    }
  }

  // The review stays recorded even when the queue cannot take the job: its
  // copy is marked failed, and the reviewer can send it again. Either way
  // the other open tabs learn about it (realtime review.updated).
  private async enqueueSync<T extends { syncStatus: ReviewSyncStatus }>(
    reviewId: string,
    review: T,
  ): Promise<T> {
    try {
      await this.reviewSyncQueue.add(
        'sync',
        { reviewId },
        {
          jobId: buildReviewSyncJobId(reviewId, Date.now()),
          attempts: REVIEW_SYNC_JOB_ATTEMPTS,
          backoff: REVIEW_SYNC_BACKOFF,
          removeOnComplete: true,
          removeOnFail: 100,
        },
      );
      return review;
    } catch (error) {
      this.logger.error('review.sync_enqueue_failed', {
        reviewId,
        error: error instanceof Error ? error.message : String(error),
      });
      await this.prisma.pullReview.update({
        where: { id: reviewId },
        data: { syncStatus: ReviewSyncStatus.FAILED, syncError: 'unknown' },
      });
      return {
        ...review,
        syncStatus: ReviewSyncStatus.FAILED,
        syncError: 'unknown',
      };
    } finally {
      await this.realtime.reviewChanged(reviewId);
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
      include: {
        latestScan: {
          select: { status: true, headSha: true, aiStatus: true },
        },
      },
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
