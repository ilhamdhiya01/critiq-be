import { ApiSuppressionReason, FindingDto } from './finding.dto';

// GET …/scans/:scanId/findings.
export class ScanFindingsDto {
  scanId!: string;
  // Active first (by file, then line), then suppressed (same order). Holds
  // only active findings when ?includeSuppressed=false.
  items!: FindingDto[];
  // Active findings per file — what the diff view badges. Suppressed ones
  // never count toward it.
  byFile!: Record<string, number>;
  // Scan totals, before the storage caps — not the length of `items`.
  criticalCount!: number;
  suppressedCount!: number;
  // Per reason, over the *stored* suppressed rows: when suppressedTruncated
  // is true these add up to 200, not to suppressedCount.
  suppressedByReason!: Record<ApiSuppressionReason, number>;
  findingsTruncated!: boolean;
  suppressedTruncated!: boolean;

  constructor(partial: ScanFindingsDto) {
    Object.assign(this, partial);
  }
}
