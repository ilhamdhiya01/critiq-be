import type { Queue } from 'bullmq';
import { Logger } from 'winston';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  AiScanStatus,
  PullRequestState,
  ReviewDecision,
  ReviewPolicy,
  ReviewSyncStatus,
  Role,
  ScanStatus,
} from '../../generated/prisma/enums';
import type { ReviewSyncJobPayload } from '../../queue/review-sync-queue.constants';
import { ReviewsService } from './reviews.service';

jest.mock('@nestjs/bullmq', () => ({ InjectQueue: () => () => undefined }));
jest.mock('bullmq', () => ({ Queue: class {} }));
jest.mock('../../common/prisma/prisma.service', () => ({
  PrismaService: class {},
}));

const ORG = 'org_1';
const REPO = 'repo_1';
const HEAD = 'abc123';

function pullRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pull_1',
    organizationId: ORG,
    repositoryId: REPO,
    headSha: HEAD,
    state: PullRequestState.OPEN,
    effectivePolicy: ReviewPolicy.ALLOW_AI,
    latestScan: {
      status: ScanStatus.DONE,
      headSha: HEAD,
      aiStatus: AiScanStatus.DONE,
    },
    ...overrides,
  };
}

function reviewRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rev_1',
    organizationId: ORG,
    pullId: 'pull_1',
    headSha: HEAD,
    decision: ReviewDecision.APPROVE,
    body: null,
    reviewerId: 'u_1',
    reviewerRole: Role.REVIEWER,
    effectivePolicy: ReviewPolicy.ALLOW_AI,
    manualConfirmation: false,
    syncStatus: ReviewSyncStatus.PENDING,
    syncError: null,
    syncedAt: null,
    createdAt: new Date('2026-10-12T05:00:00Z'),
    reviewer: { id: 'u_1', name: 'Ilham', email: 'i@x.io', avatarUrl: null },
    ...overrides,
  };
}

function setup(pull: Record<string, unknown> | null = pullRow()) {
  const prisma = {
    pullRequest: { findUnique: jest.fn().mockResolvedValue(pull) },
    membership: {
      findUniqueOrThrow: jest.fn().mockResolvedValue({ role: Role.REVIEWER }),
    },
    pullReview: {
      create: jest.fn(
        (args: { data: Record<string, unknown> }): Promise<unknown> =>
          Promise.resolve(reviewRow(args.data)),
      ),
      findMany: jest.fn().mockResolvedValue([]),
      // The reviewer's own latest decision on this commit: none by default.
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const queue = { add: jest.fn().mockResolvedValue({}) };
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const service = new ReviewsService(
    prisma as unknown as PrismaService,
    queue as unknown as Queue<ReviewSyncJobPayload>,
    logger as unknown as Logger,
  );
  return { service, prisma, queue, logger };
}

const approve = (overrides: Record<string, unknown> = {}) => ({
  decision: 'approve' as const,
  headSha: HEAD,
  ...overrides,
});

describe('ReviewsService.submit', () => {
  it('records an approval, queues its copy and audits it', async () => {
    const { service, prisma, queue, logger } = setup();

    const review = await service.submit(ORG, REPO, 'pull_1', 'u_1', approve());

    expect(prisma.pullReview.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          organizationId: ORG,
          pullId: 'pull_1',
          headSha: HEAD,
          decision: ReviewDecision.APPROVE,
          reviewerId: 'u_1',
          reviewerRole: Role.REVIEWER,
          effectivePolicy: ReviewPolicy.ALLOW_AI,
        }) as unknown,
      }),
    );
    expect(queue.add).toHaveBeenCalledWith(
      'sync',
      { reviewId: 'rev_1' },
      expect.objectContaining({ attempts: 4 }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      'audit.review.submitted',
      expect.objectContaining({ by: 'u_1', decision: ReviewDecision.APPROVE }),
    );
    expect(review).toMatchObject({
      decision: 'approve',
      reviewer: { name: 'Ilham' },
      reviewerRole: 'reviewer',
      outdated: false,
      sync: { status: 'pending', error: null },
    });
  });

  // The decision is for the commit the reviewer saw.
  it('409s when the PR has a newer head', async () => {
    const { service, prisma } = setup();
    await expect(
      service.submit(ORG, REPO, 'pull_1', 'u_1', approve({ headSha: 'old' })),
    ).rejects.toMatchObject({
      status: 409,
      response: { message: 'head_changed' },
    });
    expect(prisma.pullReview.create).not.toHaveBeenCalled();
  });

  it('422s a merged or closed PR', async () => {
    const { service } = setup(pullRow({ state: PullRequestState.MERGED }));
    await expect(
      service.submit(ORG, REPO, 'pull_1', 'u_1', approve()),
    ).rejects.toMatchObject({ response: { message: 'pull_not_open' } });
  });

  it('requires a reason to request changes', async () => {
    const { service } = setup();
    await expect(
      service.submit(ORG, REPO, 'pull_1', 'u_1', {
        decision: 'request_changes',
        headSha: HEAD,
        body: '   ',
      }),
    ).rejects.toMatchObject({ response: { message: 'body_required' } });
  });

  it('404s a PR of another organization', async () => {
    const { service } = setup(pullRow({ organizationId: 'org_other' }));
    await expect(
      service.submit(ORG, REPO, 'pull_1', 'u_1', approve()),
    ).rejects.toMatchObject({ status: 404 });
  });

  // PRD §7: manual confirmation AND a finished AI review of this commit.
  describe('Require both', () => {
    const requireBoth = (overrides: Record<string, unknown> = {}) =>
      pullRow({ effectivePolicy: ReviewPolicy.REQUIRE_BOTH, ...overrides });

    it('refuses an approval without the manual confirmation', async () => {
      const { service } = setup(requireBoth());
      await expect(
        service.submit(ORG, REPO, 'pull_1', 'u_1', approve()),
      ).rejects.toMatchObject({
        status: 422,
        response: { message: 'manual_confirmation_required' },
      });
    });

    it.each([
      [null, 'scan_required'],
      [
        {
          status: ScanStatus.DONE,
          headSha: 'old',
          aiStatus: AiScanStatus.DONE,
        },
        'scan_required',
      ],
      [
        { status: ScanStatus.FAILED, headSha: HEAD, aiStatus: null },
        'scan_required',
      ],
      [
        {
          status: ScanStatus.DONE,
          headSha: HEAD,
          aiStatus: AiScanStatus.RUNNING,
        },
        'ai_analysis_required',
      ],
      [
        {
          status: ScanStatus.DONE,
          headSha: HEAD,
          aiStatus: AiScanStatus.NOT_CONFIGURED,
        },
        'ai_analysis_required',
      ],
    ])('refuses an approval for scan %j', async (latestScan, message) => {
      const { service } = setup(requireBoth({ latestScan }));
      await expect(
        service.submit(
          ORG,
          REPO,
          'pull_1',
          'u_1',
          approve({ manualConfirmation: true }),
        ),
      ).rejects.toMatchObject({ response: { message } });
    });

    it('approves with both, a cached AI review included', async () => {
      const { service, prisma } = setup(
        requireBoth({
          latestScan: {
            status: ScanStatus.DONE,
            headSha: HEAD,
            aiStatus: AiScanStatus.CACHED,
          },
        }),
      );
      await service.submit(
        ORG,
        REPO,
        'pull_1',
        'u_1',
        approve({ manualConfirmation: true }),
      );
      expect(prisma.pullReview.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            manualConfirmation: true,
            effectivePolicy: ReviewPolicy.REQUIRE_BOTH,
          }) as unknown,
        }),
      );
    });

    // Asking for changes never needs the AI to have run.
    it('lets changes be requested without either', async () => {
      const { service } = setup(requireBoth({ latestScan: null }));
      await expect(
        service.submit(ORG, REPO, 'pull_1', 'u_1', {
          decision: 'request_changes',
          headSha: HEAD,
          body: 'Missing tests',
        }),
      ).resolves.toMatchObject({ decision: 'request_changes' });
    });
  });

  // A second identical approval would only add a duplicate bot review.
  it('409s repeating my latest decision on the same commit', async () => {
    const { service, prisma, queue } = setup();
    prisma.pullReview.findFirst.mockResolvedValue({
      decision: ReviewDecision.APPROVE,
    });
    await expect(
      service.submit(ORG, REPO, 'pull_1', 'u_1', approve()),
    ).rejects.toMatchObject({
      status: 409,
      response: { message: 'already_reviewed' },
    });
    expect(prisma.pullReview.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { pullId: 'pull_1', reviewerId: 'u_1', headSha: HEAD },
        orderBy: { createdAt: 'desc' },
      }),
    );
    expect(prisma.pullReview.create).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  // Changing one's mind on the same commit stays possible.
  it('accepts the other decision after mine', async () => {
    const { service, prisma } = setup();
    prisma.pullReview.findFirst.mockResolvedValue({
      decision: ReviewDecision.REQUEST_CHANGES,
    });
    await expect(
      service.submit(ORG, REPO, 'pull_1', 'u_1', approve()),
    ).resolves.toMatchObject({ decision: 'approve' });
  });

  // The decision is kept even when Redis is down; its copy is failed.
  it('marks the copy failed when the queue is unreachable', async () => {
    const { service, prisma, queue } = setup();
    queue.add.mockRejectedValue(new Error('ECONNREFUSED'));
    const review = await service.submit(ORG, REPO, 'pull_1', 'u_1', approve());
    expect(prisma.pullReview.update).toHaveBeenCalledWith({
      where: { id: 'rev_1' },
      data: { syncStatus: ReviewSyncStatus.FAILED, syncError: 'unknown' },
    });
    expect(review.sync).toMatchObject({ status: 'failed', error: 'unknown' });
  });
});

describe('ReviewsService.list', () => {
  it('flags reviews of an older commit as outdated', async () => {
    const { service, prisma } = setup();
    prisma.pullReview.findMany.mockResolvedValue([
      reviewRow({ id: 'rev_2' }),
      reviewRow({ id: 'rev_1', headSha: 'old' }),
    ]);
    const reviews = await service.list(ORG, REPO, 'pull_1');
    expect(reviews.map((review) => [review.id, review.outdated])).toEqual([
      ['rev_2', false],
      ['rev_1', true],
    ]);
  });
});

describe('ReviewsService.retrySync', () => {
  it('queues a failed copy again', async () => {
    const { service, prisma, queue } = setup();
    prisma.pullReview.findUnique.mockResolvedValue(
      reviewRow({
        syncStatus: ReviewSyncStatus.FAILED,
        syncError: 'not_allowed',
      }),
    );
    const review = await service.retrySync(ORG, REPO, 'pull_1', 'rev_1');
    expect(prisma.pullReview.updateMany).toHaveBeenCalledWith({
      where: { id: 'rev_1', syncStatus: ReviewSyncStatus.FAILED },
      data: { syncStatus: ReviewSyncStatus.PENDING, syncError: null },
    });
    expect(queue.add).toHaveBeenCalled();
    expect(review.sync).toMatchObject({ status: 'pending', error: null });
  });

  it.each([
    [ReviewSyncStatus.SYNCED, HEAD, 'already_synced'],
    [ReviewSyncStatus.PENDING, HEAD, 'sync_in_progress'],
    [ReviewSyncStatus.FAILED, 'old', 'head_changed'],
  ])('409s a %s copy of %s', async (syncStatus, headSha, message) => {
    const { service, prisma, queue } = setup();
    prisma.pullReview.findUnique.mockResolvedValue(
      reviewRow({ syncStatus, headSha }),
    );
    await expect(
      service.retrySync(ORG, REPO, 'pull_1', 'rev_1'),
    ).rejects.toMatchObject({ status: 409, response: { message } });
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('404s a review of another PR', async () => {
    const { service, prisma } = setup();
    prisma.pullReview.findUnique.mockResolvedValue(
      reviewRow({ pullId: 'pull_other' }),
    );
    await expect(
      service.retrySync(ORG, REPO, 'pull_1', 'rev_1'),
    ).rejects.toMatchObject({ status: 404 });
  });
});
