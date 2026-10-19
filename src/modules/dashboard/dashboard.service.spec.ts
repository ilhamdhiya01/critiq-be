import { PrismaService } from '../../common/prisma/prisma.service';
import {
  FindingSeverity,
  FindingSource,
  FindingStatus,
  PullRequestState,
  ReviewDecision,
  ReviewSyncStatus,
} from '../../generated/prisma/enums';
import { DashboardService } from './dashboard.service';

jest.mock('../../common/prisma/prisma.service', () => ({
  PrismaService: class {},
}));

const ORG = 'org_1';
const NOW = new Date('2026-10-19T12:00:00Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

// A first review `reviewedAgo` before NOW, on a PR opened `hours` earlier.
function firstReview(
  reviewedAgo: number,
  hours: number,
  options: { aiAssisted?: boolean; openedAt?: 'provider' | 'unknown' } = {},
) {
  const createdAt = ago(reviewedAgo);
  const opened = new Date(createdAt.getTime() - hours * HOUR);
  return {
    createdAt,
    aiAssisted: options.aiAssisted ?? false,
    pullRequest:
      options.openedAt === 'unknown'
        ? // Seen by Critiq first; the provider time is not known yet.
          { openedAt: null, createdAt: opened }
        : { openedAt: opened, createdAt: new Date(NOW.getTime() - HOUR) },
  };
}

const PULL_REF = {
  id: 'pull_1',
  externalId: '482',
  title: 'Add login',
  repositoryId: 'repo_1',
  repository: { path: 'acme/payments-api' },
};

function setup() {
  const prisma = {
    pullRequest: { findMany: jest.fn().mockResolvedValue([]) },
    repository: { count: jest.fn().mockResolvedValue(0) },
    pullReview: {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
    },
    finding: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const service = new DashboardService(prisma as unknown as PrismaService);
  return { service, prisma };
}

type Where = { where: Record<string, unknown> };
const wheres = (mock: jest.Mock) =>
  (mock.mock.calls as [Where][]).map(([args]) => args.where);

describe('DashboardService.summary', () => {
  it('sums active criticals of open PRs and counts the PRs that have any', async () => {
    const { service, prisma } = setup();
    prisma.pullRequest.findMany.mockResolvedValue([
      { latestScan: { criticalCount: 4 } },
      { latestScan: { criticalCount: 0 } },
      { latestScan: { criticalCount: 3 } },
      { latestScan: null },
    ]);
    const summary = await service.summary(ORG, NOW);
    expect(summary.openCritical).toEqual({ count: 7, pullCount: 2 });
    expect(wheres(prisma.pullRequest.findMany)[0]).toEqual({
      organizationId: ORG,
      state: PullRequestState.OPEN,
    });
  });

  it('counts repositories and those added since the start of the month', async () => {
    const { service, prisma } = setup();
    prisma.repository.count.mockResolvedValueOnce(6).mockResolvedValueOnce(1);
    const summary = await service.summary(ORG, NOW);
    expect(summary.repositories).toEqual({ count: 6, addedThisMonth: 1 });
    expect(wheres(prisma.repository.count)[1]).toEqual({
      organizationId: ORG,
      createdAt: { gte: new Date('2026-10-01T00:00:00Z') },
    });
  });

  it('averages turnaround this week and the week before', async () => {
    const { service, prisma } = setup();
    prisma.pullReview.findMany
      .mockResolvedValueOnce([
        firstReview(1 * DAY, 2),
        firstReview(2 * DAY, 5),
        firstReview(9 * DAY, 10),
        // Outside both windows.
        firstReview(20 * DAY, 100),
      ])
      .mockResolvedValueOnce([]);
    const summary = await service.summary(ORG, NOW);
    expect(summary.reviewTurnaround).toEqual({
      avgHours: 3.5,
      previousAvgHours: 10,
    });
  });

  // A PR opened before its repo was connected has no provider time until
  // its next webhook: Critiq's own first sighting stands in.
  it('falls back to when Critiq first saw the PR', async () => {
    const { service, prisma } = setup();
    prisma.pullReview.findMany
      .mockResolvedValueOnce([firstReview(DAY, 6, { openedAt: 'unknown' })])
      .mockResolvedValueOnce([]);
    const summary = await service.summary(ORG, NOW);
    expect(summary.reviewTurnaround.avgHours).toBe(6);
  });

  it('is null with nothing to average', async () => {
    const { service } = setup();
    const summary = await service.summary(ORG, NOW);
    expect(summary.reviewTurnaround).toEqual({
      avgHours: null,
      previousAvgHours: null,
    });
    expect(summary.reviews30d.avgApproveHours).toEqual({
      aiAssisted: null,
      manual: null,
    });
  });

  it('splits 30 days of reviews and time to approve by AI assistance', async () => {
    const { service, prisma } = setup();
    prisma.pullReview.count.mockResolvedValueOnce(10).mockResolvedValueOnce(6);
    prisma.pullReview.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
      firstReview(2 * DAY, 3, { aiAssisted: true }),
      firstReview(3 * DAY, 4, { aiAssisted: true }),
      firstReview(5 * DAY, 10),
      // First approved before the window: not this month's approval.
      firstReview(40 * DAY, 1, { aiAssisted: true }),
    ]);
    const summary = await service.summary(ORG, NOW);
    expect(summary.reviews30d).toEqual({
      total: 10,
      aiAssisted: 6,
      manual: 4,
      avgApproveHours: { aiAssisted: 3.5, manual: 10 },
    });
    expect(wheres(prisma.pullReview.findMany)[1]).toEqual({
      organizationId: ORG,
      decision: ReviewDecision.APPROVE,
    });
  });

  // Tenant isolation: no aggregate may read another organization's rows.
  it('scopes every query to the organization', async () => {
    const { service, prisma } = setup();
    await service.summary(ORG, NOW);
    for (const mock of [
      prisma.pullRequest.findMany,
      prisma.repository.count,
      prisma.pullReview.count,
      prisma.pullReview.findMany,
    ]) {
      for (const where of wheres(mock)) {
        expect(where.organizationId).toBe(ORG);
      }
    }
  });
});

describe('DashboardService.criticalIssues', () => {
  it('reads the latest scan of open PRs only, active criticals only', async () => {
    const { service, prisma } = setup();
    prisma.pullRequest.findMany.mockResolvedValue([
      { latestScanId: 'scan_1' },
      { latestScanId: 'scan_2' },
    ]);
    await service.criticalIssues(ORG, 50);
    expect(wheres(prisma.pullRequest.findMany)[0]).toEqual({
      organizationId: ORG,
      state: PullRequestState.OPEN,
      latestScanId: { not: null },
    });
    expect(prisma.finding.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: ORG,
          scanId: { in: ['scan_1', 'scan_2'] },
          severity: FindingSeverity.CRITICAL,
          suppressedReason: null,
          status: { not: FindingStatus.RESOLVED },
        },
        take: 50,
      }),
    );
  });

  it('skips the findings query without open scanned PRs', async () => {
    const { service, prisma } = setup();
    await expect(service.criticalIssues(ORG)).resolves.toEqual([]);
    expect(prisma.finding.findMany).not.toHaveBeenCalled();
  });

  it('dates an issue from the scan that first found it', async () => {
    const { service, prisma } = setup();
    prisma.pullRequest.findMany.mockResolvedValue([{ latestScanId: 'scan_1' }]);
    prisma.finding.findMany.mockResolvedValue([
      {
        id: 'f1',
        title: 'Hard-coded JWT fallback secret',
        source: FindingSource.STATIC,
        filePath: 'src/config.ts',
        lineStart: 12,
        firstSeenIn: { createdAt: ago(HOUR), finishedAt: ago(HOUR - 60_000) },
        pullRequest: PULL_REF,
      },
    ]);
    await expect(service.criticalIssues(ORG)).resolves.toEqual([
      {
        findingId: 'f1',
        title: 'Hard-coded JWT fallback secret',
        source: FindingSource.STATIC,
        filePath: 'src/config.ts',
        lineStart: 12,
        firstSeenAt: ago(HOUR - 60_000),
        pull: {
          id: 'pull_1',
          number: '482',
          title: 'Add login',
          repoId: 'repo_1',
          repoPath: 'acme/payments-api',
        },
      },
    ]);
  });
});

describe('DashboardService.recentReviews', () => {
  it('lists the newest decisions with reviewer, mode and PR', async () => {
    const { service, prisma } = setup();
    prisma.pullReview.findMany.mockResolvedValue([
      {
        id: 'rev_1',
        decision: ReviewDecision.REQUEST_CHANGES,
        aiAssisted: false,
        syncStatus: ReviewSyncStatus.SYNCED,
        createdAt: ago(HOUR),
        reviewer: null,
        pullRequest: PULL_REF,
      },
    ]);
    const [review] = await service.recentReviews(ORG, 5);
    expect(review).toMatchObject({
      decision: 'request_changes',
      aiAssisted: false,
      sync: { status: 'synced' },
      reviewer: null,
      pull: { number: '482', repoPath: 'acme/payments-api' },
    });
    expect(prisma.pullReview.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: ORG },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 5,
      }),
    );
  });
});
