import type { ReviewDto } from '../../reviews/dto/review.dto';
import {
  Provider,
  PullRequestState,
  ReviewPolicy,
} from '../../../generated/prisma/enums';
import { ScanSummaryDto } from './scan-summary.dto';

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
    latestScan: ScanSummaryDto | null;
    createdAt: Date;
    updatedAt: Date;
  }) {
    Object.assign(this, partial);
  }
}
