// The `comment-sync` queue (v1.5.2): one job per comment written in Critiq,
// to copy to GitHub/GitLab. Same Redis and worker as the other queues.
export const COMMENT_SYNC_QUEUE_NAME = 'comment-sync';

export interface CommentSyncJobPayload {
  commentId: string;
}

// No ':' (BullMQ 6); the timestamp keeps a retry from colliding with the
// earlier job BullMQ may still hold.
export function buildCommentSyncJobId(
  commentId: string,
  requestedAt: number,
): string {
  return `comment-sync-${commentId}-${requestedAt}`;
}

export const COMMENT_SYNC_JOB_ATTEMPTS = 4; // 1 + 3 retries
export const COMMENT_SYNC_BACKOFF = { type: 'exponential', delay: 10_000 };
