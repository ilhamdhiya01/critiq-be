import { ScanStatus, ScanTrigger } from '../../../generated/prisma/enums';
import { FindingDto } from '../../scans/dto/finding.dto';

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
  // Findings stored for visibility but not counted (test files, regex
  // literals). They are not in `findings` below — see GET
  // orgs/:orgId/scans/:scanId/findings.
  suppressedCount!: number;
  suppressedTruncated!: boolean;
  filesChanged!: number | null;
  diffBytes!: number | null;
  rulesetVersion!: string;
  // Populated only when status is FAILED.
  errorMessage!: string | null;
  startedAt!: Date | null;
  finishedAt!: Date | null;
  // Active findings only.
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
    suppressedCount: number;
    suppressedTruncated: boolean;
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
