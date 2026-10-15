// Why sending a comment to GitHub/GitLab failed (v1.5.2). Stored in
// pull_comments.syncError and shown to the FE.
export type CommentSyncErrorCode =
  // Critiq's App or the org token cannot comment here.
  | 'insufficient_permission'
  // The provider could not place an inline comment on that line — usually
  // the line is no longer part of the diff.
  | 'invalid_position'
  // A reply whose thread has not reached the provider yet.
  | 'parent_not_synced'
  | 'provider_unreachable'
  | 'unknown';

// Thrown by the provider comment calls. `retryable` errors are retried by
// the comment-sync queue; the others fail the sync at once.
export class ProviderCommentError extends Error {
  constructor(
    readonly code: CommentSyncErrorCode,
    readonly retryable: boolean,
    readonly detail?: string,
  ) {
    super(code);
  }
}
