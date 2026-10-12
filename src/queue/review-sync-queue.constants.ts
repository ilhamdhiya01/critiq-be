// The `review-sync` queue (v1.5.2): one job per review decision to copy to
// GitHub/GitLab. Same Redis and worker process as the scan and ai queues.
export const REVIEW_SYNC_QUEUE_NAME = 'review-sync';

// The id only — the worker loads the review, the PR and the org's
// credential from the DB when it runs.
export interface ReviewSyncJobPayload {
  reviewId: string;
}

// Same reasoning as buildAiJobId: no ':' (BullMQ 6), and a retry of a failed
// sync must not collide with the earlier job still kept by BullMQ.
export function buildReviewSyncJobId(
  reviewId: string,
  requestedAt: number,
): string {
  return `review-sync-${reviewId}-${requestedAt}`;
}

export const REVIEW_SYNC_JOB_ATTEMPTS = 4; // 1 + 3 retries
export const REVIEW_SYNC_BACKOFF = { type: 'exponential', delay: 10_000 };
