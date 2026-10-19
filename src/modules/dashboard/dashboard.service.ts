import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  FindingSeverity,
  FindingStatus,
  PullRequestState,
  ReviewDecision,
} from '../../generated/prisma/enums';
import type { ReviewActivityItemDto } from '../activity/dto/activity.dto';
import {
  REVIEW_ACTIVITY_SELECT,
  toReviewActivityItem,
} from '../activity/review-activity';
import { PULL_REF_SELECT, toPullRef } from '../pulls/dto/pull-ref.dto';
import { CriticalIssueDto, DashboardSummaryDto } from './dto/dashboard.dto';

export const DASHBOARD_LIST_LIMIT = 5;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

// The first review of a PR, with when the PR was opened.
interface FirstReview {
  createdAt: Date;
  aiAssisted: boolean;
  pullRequest: { openedAt: Date | null; createdAt: Date };
}

// PR opened (on the provider; when Critiq first saw it for PRs older than
// `openedAt`) → this review, in hours. Never negative.
const hoursToReview = (review: FirstReview) =>
  Math.max(
    0,
    review.createdAt.getTime() -
      (review.pullRequest.openedAt ?? review.pullRequest.createdAt).getTime(),
  ) / HOUR_MS;

function averageHours(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.round(mean * 10) / 10;
}

const within = (date: Date, from: Date, to: Date) =>
  date.getTime() >= from.getTime() && date.getTime() < to.getTime();

// The Dashboard menu: read-only aggregates of one organization, from the
// database only. Every query is scoped by organizationId. No quality gate
// until v1.5.3 (it needs CI, which was withdrawn) — see CLAUDE.md
// "Dashboard".
@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async summary(
    organizationId: string,
    now: Date = new Date(),
  ): Promise<DashboardSummaryDto> {
    const weekAgo = new Date(now.getTime() - 7 * DAY_MS);
    const twoWeeksAgo = new Date(now.getTime() - 14 * DAY_MS);
    const monthAgo = new Date(now.getTime() - 30 * DAY_MS);
    const monthStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    );
    const firstReviewSelect = {
      createdAt: true,
      aiAssisted: true,
      pullRequest: { select: { openedAt: true, createdAt: true } },
    } as const;

    const [
      openPulls,
      repositoryCount,
      repositoriesAdded,
      reviewsTotal,
      reviewsAiAssisted,
      firstReviews,
      firstApprovals,
    ] = await Promise.all([
      this.prisma.pullRequest.findMany({
        where: { organizationId, state: PullRequestState.OPEN },
        select: { latestScan: { select: { criticalCount: true } } },
      }),
      this.prisma.repository.count({ where: { organizationId } }),
      this.prisma.repository.count({
        where: { organizationId, createdAt: { gte: monthStart } },
      }),
      this.prisma.pullReview.count({
        where: { organizationId, createdAt: { gte: monthAgo } },
      }),
      this.prisma.pullReview.count({
        where: {
          organizationId,
          createdAt: { gte: monthAgo },
          aiAssisted: true,
        },
      }),
      // First decision of every PR, then kept when it falls in a window: a
      // PR first reviewed last month and again this week is not counted.
      this.prisma.pullReview.findMany({
        where: { organizationId },
        orderBy: [{ pullId: 'asc' }, { createdAt: 'asc' }],
        distinct: ['pullId'],
        select: firstReviewSelect,
      }),
      this.prisma.pullReview.findMany({
        where: { organizationId, decision: ReviewDecision.APPROVE },
        orderBy: [{ pullId: 'asc' }, { createdAt: 'asc' }],
        distinct: ['pullId'],
        select: firstReviewSelect,
      }),
    ]);

    const criticalCounts = openPulls.map(
      (pull) => pull.latestScan?.criticalCount ?? 0,
    );
    const approvals = firstApprovals.filter((review) =>
      within(review.createdAt, monthAgo, now),
    );

    return new DashboardSummaryDto({
      openCritical: {
        count: criticalCounts.reduce((sum, count) => sum + count, 0),
        pullCount: criticalCounts.filter((count) => count > 0).length,
      },
      repositories: {
        count: repositoryCount,
        addedThisMonth: repositoriesAdded,
      },
      reviewTurnaround: {
        avgHours: averageHours(
          firstReviews
            .filter((review) => within(review.createdAt, weekAgo, now))
            .map(hoursToReview),
        ),
        previousAvgHours: averageHours(
          firstReviews
            .filter((review) => within(review.createdAt, twoWeeksAgo, weekAgo))
            .map(hoursToReview),
        ),
      },
      reviews30d: {
        total: reviewsTotal,
        aiAssisted: reviewsAiAssisted,
        manual: reviewsTotal - reviewsAiAssisted,
        avgApproveHours: {
          aiAssisted: averageHours(
            approvals.filter((review) => review.aiAssisted).map(hoursToReview),
          ),
          manual: averageHours(
            approvals.filter((review) => !review.aiAssisted).map(hoursToReview),
          ),
        },
      },
    });
  }

  // Active criticals (not suppressed, not resolved) of the latest scan of
  // every open PR — what criticalCount counts — newest first.
  async criticalIssues(
    organizationId: string,
    limit = DASHBOARD_LIST_LIMIT,
  ): Promise<CriticalIssueDto[]> {
    const openPulls = await this.prisma.pullRequest.findMany({
      where: {
        organizationId,
        state: PullRequestState.OPEN,
        latestScanId: { not: null },
      },
      select: { latestScanId: true },
    });
    const scanIds = openPulls.flatMap((pull) =>
      pull.latestScanId ? [pull.latestScanId] : [],
    );
    if (scanIds.length === 0) {
      return [];
    }
    const findings = await this.prisma.finding.findMany({
      where: {
        organizationId,
        scanId: { in: scanIds },
        severity: FindingSeverity.CRITICAL,
        suppressedReason: null,
        status: { not: FindingStatus.RESOLVED },
      },
      orderBy: [{ firstSeenIn: { createdAt: 'desc' } }, { id: 'asc' }],
      take: limit,
      select: {
        id: true,
        title: true,
        source: true,
        filePath: true,
        lineStart: true,
        firstSeenIn: { select: { createdAt: true, finishedAt: true } },
        pullRequest: { select: PULL_REF_SELECT },
      },
    });
    return findings.map(
      (finding) =>
        new CriticalIssueDto({
          findingId: finding.id,
          title: finding.title,
          source: finding.source,
          filePath: finding.filePath,
          lineStart: finding.lineStart,
          firstSeenAt:
            finding.firstSeenIn.finishedAt ?? finding.firstSeenIn.createdAt,
          pull: toPullRef(finding.pullRequest),
        }),
    );
  }

  async recentReviews(
    organizationId: string,
    limit = DASHBOARD_LIST_LIMIT,
  ): Promise<ReviewActivityItemDto[]> {
    const reviews = await this.prisma.pullReview.findMany({
      where: { organizationId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
      select: REVIEW_ACTIVITY_SELECT,
    });
    return reviews.map(toReviewActivityItem);
  }
}
