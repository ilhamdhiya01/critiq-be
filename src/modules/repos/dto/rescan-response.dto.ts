export class RescanResponseDto {
  enqueued!: number;
  // Only meaningful for `stale=1`: open PRs whose last scan already ran on
  // the current ruleset and so were left alone.
  skippedUpToDate!: number;

  constructor(partial: { enqueued: number; skippedUpToDate: number }) {
    Object.assign(this, partial);
  }
}
