import { ApiSuppressionReason, FindingDto } from './finding.dto';

// GET …/scans/:scanId/findings.
export class ScanFindingsDto {
  scanId!: string;
  // Not suppressed first — reopened, new, persisted, then resolved, each by
  // severity, file, line — then suppressed (same order). Holds
  // only active findings when ?includeSuppressed=false.
  items!: FindingDto[];
  // Active findings per file — what the diff view badges. Suppressed ones
  // never count toward it.
  byFile!: Record<string, number>;
  // Over active findings (not suppressed) — v1.5.1: static rules and the AI
  // review; Major/Minor come from the AI only.
  bySource!: { static: number; ai: number };
  bySeverity!: { critical: number; major: number; minor: number };
  // Every status in this scan (not suppressed), whatever ?status= selected.
  byStatus!: {
    new: number;
    persisted: number;
    reopened: number;
    resolved: number;
  };
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
