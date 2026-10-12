// Why GitHub/GitLab refused a merge sent from Critiq (v1.5.2). The provider
// has the last word: its own branch protection, CI and conflicts apply.
export type MergeErrorCode =
  // The sha sent is no longer the PR's head.
  | 'head_changed'
  // Conflicts, a required check or approval on the provider, a merge method
  // the repository does not allow, a draft — `detail` says which.
  | 'not_mergeable'
  // Critiq's App or the org token may not merge here.
  | 'insufficient_permission'
  | 'provider_unreachable';

export class ProviderMergeError extends Error {
  constructor(
    readonly code: MergeErrorCode,
    // The provider's own reason, short; shown to the user for not_mergeable.
    readonly detail?: string,
  ) {
    super(code);
  }
}
