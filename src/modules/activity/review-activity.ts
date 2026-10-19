import {
  ReviewDecision,
  type ReviewSyncStatus,
} from '../../generated/prisma/enums';
import { PULL_REF_SELECT, toPullRef } from '../pulls/dto/pull-ref.dto';
import { ReviewActivityItemDto } from './dto/activity.dto';

// One review decision as the Activity timeline and the dashboard's "Recent
// activity" show it — one select and one mapper, so the two stay the same.
export const REVIEW_ACTIVITY_SELECT = {
  id: true,
  decision: true,
  aiAssisted: true,
  syncStatus: true,
  createdAt: true,
  reviewer: {
    select: { id: true, name: true, email: true, avatarUrl: true },
  },
  pullRequest: { select: PULL_REF_SELECT },
} as const;

interface ReviewActivityRow {
  id: string;
  decision: ReviewDecision;
  aiAssisted: boolean;
  syncStatus: ReviewSyncStatus;
  createdAt: Date;
  reviewer: {
    id: string;
    name: string | null;
    email: string;
    avatarUrl: string | null;
  } | null;
  pullRequest: Parameters<typeof toPullRef>[0];
}

export function toReviewActivityItem(
  review: ReviewActivityRow,
): ReviewActivityItemDto {
  return new ReviewActivityItemDto({
    id: review.id,
    decision:
      review.decision === ReviewDecision.APPROVE
        ? 'approve'
        : 'request_changes',
    aiAssisted: review.aiAssisted,
    sync: {
      status:
        review.syncStatus.toLowerCase() as ReviewActivityItemDto['sync']['status'],
    },
    reviewer: review.reviewer
      ? {
          id: review.reviewer.id,
          name: review.reviewer.name ?? review.reviewer.email,
          avatarUrl: review.reviewer.avatarUrl,
        }
      : null,
    pull: toPullRef(review.pullRequest),
    createdAt: review.createdAt,
  });
}
