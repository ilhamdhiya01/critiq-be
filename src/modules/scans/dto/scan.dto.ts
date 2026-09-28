import {
  ScanErrorCode,
  ScanStatus,
  ScanTrigger,
} from '../../../generated/prisma/enums';

// What the worker last reported through job.updateProgress() — see
// ScanProcessor. Only present while the scan is QUEUED/RUNNING and its job
// is still in Redis.
export interface ScanProgress {
  step: string;
  pct: number;
}

// One scan attempt, without findings — the row for the PR's scan history and
// the body of GET …/scans/:scanId (which the FE polls while a scan runs).
export class ScanDto {
  id!: string;
  pullId!: string;
  status!: ScanStatus;
  trigger!: ScanTrigger;
  attempt!: number;
  headSha!: string;
  // Active findings only, counted before the 500-row storage cap.
  findingsCount!: number;
  criticalCount!: number;
  findingsTruncated!: boolean;
  // Suppressed findings (test_file / regex_literal), before the 200-row cap.
  suppressedCount!: number;
  suppressedTruncated!: boolean;
  filesChanged!: number | null;
  diffBytes!: number | null;
  rulesetVersion!: string;
  errorCode!: ScanErrorCode | null;
  errorMessage!: string | null;
  createdAt!: Date;
  startedAt!: Date | null;
  finishedAt!: Date | null;

  constructor(partial: ScanDto) {
    Object.assign(this, partial);
  }
}

export class ScanStatusDto extends ScanDto {
  progress!: ScanProgress | null;
  // 1 = next to be picked up. Only while QUEUED; null when the job is not in
  // the first 1000 waiting (or Redis could not be asked).
  queuePosition!: number | null;

  constructor(
    partial: ScanDto & {
      progress: ScanProgress | null;
      queuePosition: number | null;
    },
  ) {
    super(partial);
    this.progress = partial.progress;
    this.queuePosition = partial.queuePosition;
  }
}

// Returned by POST …/pulls/:id/scans (202).
export class ScanRequestedDto {
  scanId!: string;
  status!: ScanStatus;

  constructor(partial: { scanId: string; status: ScanStatus }) {
    Object.assign(this, partial);
  }
}

// An in-flight scan, embedded in PR list rows so the list can show a spinner
// without a request per row.
export class ActiveScanDto {
  id!: string;
  status!: ScanStatus;
  progress!: ScanProgress | null;

  constructor(partial: {
    id: string;
    status: ScanStatus;
    progress: ScanProgress | null;
  }) {
    Object.assign(this, partial);
  }
}

// The PR's last terminal scan (PullRequest.latestScan), as shown in lists.
export class LatestScanDto {
  id!: string;
  status!: ScanStatus;
  criticalCount!: number;
  suppressedCount!: number;
  finishedAt!: Date | null;

  constructor(partial: {
    id: string;
    status: ScanStatus;
    criticalCount: number;
    suppressedCount: number;
    finishedAt: Date | null;
  }) {
    Object.assign(this, partial);
  }
}
