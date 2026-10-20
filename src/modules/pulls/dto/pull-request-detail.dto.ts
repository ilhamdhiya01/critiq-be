import type { MergeBlocker } from '../../reviews/merge-blockers';
import type { ReviewDto } from '../../reviews/dto/review.dto';
import {
  Provider,
  PullRequestState,
  ReviewPolicy,
} from '../../../generated/prisma/enums';
import { ScanSummaryDto } from './scan-summary.dto';

// A reviewer's latest decision on this PR, on any commit.
export interface PullReviewerDto {
  reviewId: string;
  reviewer: ReviewDto['reviewer'];
  decision: ReviewDto['decision'];
  headSha: string;
  // Decided on an older commit than the current head.
  outdated: boolean;
  aiAssisted: boolean;
  sync: {
    status: ReviewDto['sync']['status'];
    error: ReviewDto['sync']['error'];
  };
  createdAt: Date;
}

export class PullRequestDetailDto {
  id!: string;
  repositoryId!: string;
  provider!: Provider;
  externalId!: string;
  title!: string;
  repositoryPath!: string;
  authorUsername!: string | null;
  sourceBranch!: string;
  targetBranch!: string;
  headSha!: string | null;
  state!: PullRequestState;
  effectivePolicy!: ReviewPolicy;
  // The most recent review decision (v1.5.2); null before any.
  latestReview!: ReviewDto | null;
  // Every reviewer once, with their latest decision: decisions on the head
  // first, then outdated ones, newest first within each.
  reviewers!: PullReviewerDto[];
  // Whether Merge is enabled in Critiq, and if not why (v1.5.2).
  merge!: { allowed: boolean; blockers: MergeBlocker[] };
  // null when no scan has reached a terminal state yet — a PR that was only
  // just opened, or whose every attempt so far is still running. The review
  // page renders its "not scanned yet" state from this, not from a zeroed
  // summary.
  latestScan!: ScanSummaryDto | null;
  createdAt!: Date;
  updatedAt!: Date;

  constructor(partial: {
    id: string;
    repositoryId: string;
    provider: Provider;
    externalId: string;
    title: string;
    repositoryPath: string;
    authorUsername: string | null;
    sourceBranch: string;
    targetBranch: string;
    headSha: string | null;
    state: PullRequestState;
    effectivePolicy: ReviewPolicy;
    latestReview: ReviewDto | null;
    reviewers: PullReviewerDto[];
    merge: { allowed: boolean; blockers: MergeBlocker[] };
    latestScan: ScanSummaryDto | null;
    createdAt: Date;
    updatedAt: Date;
  }) {
    Object.assign(this, partial);
  }
}
