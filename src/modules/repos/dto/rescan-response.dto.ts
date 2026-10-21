export class RescanResponseDto {
  enqueued!: number;
  // Only meaningful for `stale=1`: open PRs whose last scan already ran on
  // the current ruleset and so were left alone.
  skippedUpToDate!: number;
  // Open PRs left alone because their scan or its AI review is still
  // running (rescanBlocker).
  skippedInFlight!: number;

  constructor(partial: {
    enqueued: number;
    skippedUpToDate: number;
    skippedInFlight: number;
  }) {
    Object.assign(this, partial);
  }
}
