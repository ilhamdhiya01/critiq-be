import type { PullReview, User } from '../../../generated/prisma/client';
import type { ReviewSyncErrorCode } from '../../integrations/provider-review-error';

// What every review query loads: the reviewer, for the name on the review.
export const REVIEW_INCLUDE = {
  reviewer: { select: { id: true, name: true, email: true, avatarUrl: true } },
} as const;

type ReviewRow = PullReview & {
  reviewer: Pick<User, 'id' | 'name' | 'email' | 'avatarUrl'> | null;
};

// A human's decision on a PR, and the state of its copy on GitHub/GitLab.
export class ReviewDto {
  id!: string;
  decision!: 'approve' | 'request_changes';
  body!: string | null;
  headSha!: string;
  // Null when the reviewer's account was deleted since.
  reviewer!: { id: string; name: string; avatarUrl: string | null } | null;
  reviewerRole!: 'admin' | 'reviewer' | 'viewer';
  effectivePolicy!: 'manual_only' | 'allow_ai' | 'require_both';
  manualConfirmation!: boolean;
  // The PR has commits newer than the one reviewed.
  outdated!: boolean;
  sync!: {
    status: 'pending' | 'synced' | 'failed';
    error: ReviewSyncErrorCode | null;
    syncedAt: Date | null;
  };
  createdAt!: Date;

  constructor(partial: ReviewDto) {
    Object.assign(this, partial);
  }
}

export function toReviewDto(
  row: ReviewRow,
  pullHeadSha: string | null,
): ReviewDto {
  return new ReviewDto({
    id: row.id,
    decision: row.decision === 'APPROVE' ? 'approve' : 'request_changes',
    body: row.body,
    headSha: row.headSha,
    reviewer: row.reviewer
      ? {
          id: row.reviewer.id,
          name: row.reviewer.name ?? row.reviewer.email,
          avatarUrl: row.reviewer.avatarUrl,
        }
      : null,
    reviewerRole: row.reviewerRole.toLowerCase() as ReviewDto['reviewerRole'],
    effectivePolicy:
      row.effectivePolicy.toLowerCase() as ReviewDto['effectivePolicy'],
    manualConfirmation: row.manualConfirmation,
    outdated: pullHeadSha !== null && row.headSha !== pullHeadSha,
    sync: {
      status: row.syncStatus.toLowerCase() as ReviewDto['sync']['status'],
      error: row.syncError as ReviewSyncErrorCode | null,
      syncedAt: row.syncedAt,
    },
    createdAt: row.createdAt,
  });
}
