import type { ReviewDto } from '../../reviews/dto/review.dto';
import {
  Provider,
  PullRequestState,
  ReviewPolicy,
} from '../../../generated/prisma/enums';
import { ActiveScanDto, LatestScanDto } from '../../scans/dto/scan.dto';

export class PullRequestListItemDto {
  id!: string;
  provider!: Provider;
  externalId!: string;
  title!: string;
  authorUsername!: string | null;
  sourceBranch!: string;
  targetBranch!: string;
  state!: PullRequestState;
  effectivePolicy!: ReviewPolicy;
  // The most recent review decision (v1.5.2); null before any.
  latestReview!: ReviewDto | null;
  // Last terminal scan (the result shown), and the scan in flight if any —
  // both null for a PR that was never scanned.
  latestScan!: LatestScanDto | null;
  activeScan!: ActiveScanDto | null;
  createdAt!: Date;
  updatedAt!: Date;

  constructor(partial: {
    id: string;
    provider: Provider;
    externalId: string;
    title: string;
    authorUsername: string | null;
    sourceBranch: string;
    targetBranch: string;
    state: PullRequestState;
    effectivePolicy: ReviewPolicy;
    latestReview: ReviewDto | null;
    latestScan: LatestScanDto | null;
    activeScan: ActiveScanDto | null;
    createdAt: Date;
    updatedAt: Date;
  }) {
    Object.assign(this, partial);
  }
}
