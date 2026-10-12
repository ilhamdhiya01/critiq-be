// Why sending a review decision to GitHub/GitLab failed (v1.5.2). Stored in
// pull_reviews.syncError and shown to the FE, so each one names its fix.
export type ReviewSyncErrorCode =
  // The provider no longer takes the decision for this commit: a newer push.
  | 'head_changed'
  // Critiq's App or the org token cannot review (missing permission,
  // revoked or expired credential, App uninstalled).
  | 'insufficient_permission'
  // The provider refused this approver (e.g. the token owner wrote the MR,
  // or is not an eligible approver).
  | 'not_allowed'
  | 'provider_unreachable'
  | 'unknown';

// Thrown by the provider review calls. `retryable` errors are retried by
// the review-sync queue; the others fail the sync at once.
export class ProviderReviewError extends Error {
  constructor(
    readonly code: ReviewSyncErrorCode,
    readonly retryable: boolean,
    // The provider's own reason, short — for the log, never the API.
    readonly detail?: string,
  ) {
    super(code);
  }
}
