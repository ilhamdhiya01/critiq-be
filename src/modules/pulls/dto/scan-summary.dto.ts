import {
  FindingSeverity,
  FindingSource,
  ScanStatus,
  ScanTrigger,
} from '../../../generated/prisma/enums';

// One flagged issue from a scan. Mirrors the Finding row minus the internal
// bookkeeping the FE has no use for (organizationId, scanId, fingerprint) —
// the usual "never return a raw Prisma entity" rule.
export class FindingDto {
  id!: string;
  source!: FindingSource;
  ruleId!: string;
  severity!: FindingSeverity;
  title!: string;
  message!: string;
  filePath!: string;
  lineStart!: number;
  lineEnd!: number;
  snippet!: string | null;

  constructor(partial: {
    id: string;
    source: FindingSource;
    ruleId: string;
    severity: FindingSeverity;
    title: string;
    message: string;
    filePath: string;
    lineStart: number;
    lineEnd: number;
    snippet: string | null;
  }) {
    Object.assign(this, partial);
  }
}

// The scan a PR's review page is built from, plus its findings.
//
// Always the PR's `latestScan` — the last scan to reach a terminal state —
// never an in-flight one, so the page shows a complete result or nothing at
// all rather than a half-filled count that changes under the reader.
export class ScanSummaryDto {
  id!: string;
  status!: ScanStatus;
  trigger!: ScanTrigger;
  attempt!: number;
  headSha!: string;
  findingsCount!: number;
  criticalCount!: number;
  // True when this scan hit the 500-findings cap: `findings` below holds the
  // first 500, and the FE should say there were more.
  findingsTruncated!: boolean;
  filesChanged!: number | null;
  diffBytes!: number | null;
  rulesetVersion!: string;
  // Populated only when status is FAILED.
  errorMessage!: string | null;
  startedAt!: Date | null;
  finishedAt!: Date | null;
  findings!: FindingDto[];

  constructor(partial: {
    id: string;
    status: ScanStatus;
    trigger: ScanTrigger;
    attempt: number;
    headSha: string;
    findingsCount: number;
    criticalCount: number;
    findingsTruncated: boolean;
    filesChanged: number | null;
    diffBytes: number | null;
    rulesetVersion: string;
    errorMessage: string | null;
    startedAt: Date | null;
    finishedAt: Date | null;
    findings: FindingDto[];
  }) {
    Object.assign(this, partial);
  }
}
