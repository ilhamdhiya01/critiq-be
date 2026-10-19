import type { FindingSource } from '../../../generated/prisma/enums';

// Hours are rounded to one decimal; null when there is nothing to average.
export class DashboardSummaryDto {
  // Active criticals in the latest scan of open PRs, and how many open PRs
  // have any. No trend: that would need a daily snapshot.
  openCritical!: { count: number; pullCount: number };
  repositories!: { count: number; addedThisMonth: number };
  // PR opened → its first review decision, for PRs first reviewed in the
  // last 7 days, and in the 7 days before that.
  reviewTurnaround!: {
    avgHours: number | null;
    previousAvgHours: number | null;
  };
  reviews30d!: {
    total: number;
    aiAssisted: number;
    manual: number;
    // PR opened → its first approval, by whether that approval was
    // AI-assisted.
    avgApproveHours: { aiAssisted: number | null; manual: number | null };
  };

  constructor(partial: DashboardSummaryDto) {
    Object.assign(this, partial);
  }
}

export interface DashboardPullRef {
  id: string;
  number: string;
  title: string;
  repoId: string;
  repoPath: string;
}

export class CriticalIssueDto {
  findingId!: string;
  title!: string;
  source!: FindingSource;
  filePath!: string;
  lineStart!: number;
  // When the finding first appeared on the PR (it is carried scan to scan).
  firstSeenAt!: Date;
  pull!: DashboardPullRef;

  constructor(partial: CriticalIssueDto) {
    Object.assign(this, partial);
  }
}

export class RecentReviewDto {
  id!: string;
  decision!: 'approve' | 'request_changes';
  aiAssisted!: boolean;
  sync!: { status: 'pending' | 'synced' | 'failed' };
  // Null when the reviewer's account was deleted since.
  reviewer!: { id: string; name: string; avatarUrl: string | null } | null;
  pull!: DashboardPullRef;
  createdAt!: Date;

  constructor(partial: RecentReviewDto) {
    Object.assign(this, partial);
  }
}
