import { randomUUID } from 'crypto';
import { Prisma } from '../../generated/prisma/client';
import {
  FindingCategory,
  FindingSeverity,
  FindingSource,
  FindingStatus,
  SuppressionReason,
} from '../../generated/prisma/enums';
import { CarryFile, carryForward } from './carry-forward';
import {
  assignNewOrReopened,
  dropPersistedDuplicates,
  matchFullAgainstBase,
  ResolvedFinding,
} from './status-matcher';

// A finding row as read back from the DB (base scan, recent resolved).
export interface StoredFinding {
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
  fingerprint: string;
  suppressedReason: SuppressionReason | null;
  category: FindingCategory | null;
  confidence: { toNumber(): number } | number | null;
  firstSeenScanId: string;
  dedupeOfId?: string | null;
}

// A finding this scan's rules/model just produced.
export interface CandidateFinding {
  source: FindingSource;
  ruleId: string;
  severity: FindingSeverity;
  title: string;
  message: string;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  snippet: string | null;
  fingerprint: string;
  suppressedReason: SuppressionReason | null;
  category: FindingCategory | null;
  confidence: number | null;
  dedupeOfId?: string | null;
}

// Ready for createMany once organizationId/scanId/pullId are added. Ids are
// assigned here so a REOPENED row can point at a RESOLVED row created in the
// same transaction.
export type FindingRow = Omit<
  Prisma.FindingCreateManyInput,
  'organizationId' | 'scanId' | 'pullId'
> & { id: string; status: FindingStatus };

function confidenceOf(value: StoredFinding['confidence']): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  return typeof value === 'number' ? value : value.toNumber();
}

function fromStored(
  base: StoredFinding,
  scanId: string,
  status: FindingStatus,
  at?: { filePath: string; lineStart: number; lineEnd: number },
): FindingRow {
  return {
    id: randomUUID(),
    source: base.source,
    ruleId: base.ruleId,
    severity: base.severity,
    title: base.title,
    message: base.message,
    filePath: at?.filePath ?? base.filePath,
    lineStart: at?.lineStart ?? base.lineStart,
    lineEnd: at?.lineEnd ?? base.lineEnd,
    snippet: base.snippet,
    fingerprint: base.fingerprint,
    suppressedReason: base.suppressedReason,
    category: base.category,
    confidence: confidenceOf(base.confidence),
    dedupeOfId: base.dedupeOfId ?? null,
    status,
    firstSeenScanId: base.firstSeenScanId,
    originFindingId: base.id,
    resolvedInScanId: status === FindingStatus.RESOLVED ? scanId : null,
  };
}

function fromCandidate(
  candidate: CandidateFinding,
  scanId: string,
  status: FindingStatus,
  origin?: { id: string; firstSeenScanId: string },
): FindingRow {
  return {
    id: randomUUID(),
    source: candidate.source,
    ruleId: candidate.ruleId,
    severity: candidate.severity,
    title: candidate.title,
    message: candidate.message,
    filePath: candidate.filePath,
    lineStart: candidate.lineStart,
    lineEnd: candidate.lineEnd,
    snippet: candidate.snippet,
    fingerprint: candidate.fingerprint,
    suppressedReason: candidate.suppressedReason,
    category: candidate.category,
    confidence: candidate.confidence,
    dedupeOfId: candidate.dedupeOfId ?? null,
    status,
    firstSeenScanId: origin?.firstSeenScanId ?? scanId,
    originFindingId: origin?.id ?? null,
    resolvedInScanId: null,
  };
}

function asResolved(row: FindingRow | StoredFinding): ResolvedFinding {
  return {
    id: row.id,
    source: row.source,
    filePath: row.filePath,
    lineStart: row.lineStart,
    category: row.category ?? null,
    title: row.title,
    fingerprint: row.fingerprint,
    firstSeenScanId: row.firstSeenScanId,
  };
}

export interface PlanInput {
  scanId: string;
  candidates: CandidateFinding[];
  // How this scan relates to its base:
  //  - `carry`: incremental — base findings go through the diff (files);
  //  - `match`: full scan with a base — base findings are matched to the
  //    candidates by fingerprint;
  //  - none: first scan, or nothing of this source to continue.
  carry?: { base: StoredFinding[]; files: CarryFile[] };
  match?: { base: StoredFinding[] };
  // Findings already continued into this scan (e.g. the AI's persisted rows
  // written by the static step) — candidates duplicating them are dropped.
  alreadyPersisted?: { fingerprint: string }[];
  // RESOLVED rows of the PR's last few scans, this scan included — what a
  // candidate may re-open.
  recentResolved: StoredFinding[];
}

export interface PlanResult {
  rows: FindingRow[];
  // Fingerprints of candidates stored as NEW — for the window-miss log.
  newFingerprints: string[];
}

// Statuses for one step of one scan (v1.5.1 langkah 3).
export function planFindings(input: PlanInput): PlanResult {
  const rows: FindingRow[] = [];
  let candidates = input.candidates;
  const resolvedPool: ResolvedFinding[] = input.recentResolved.map(asResolved);

  if (input.carry) {
    const { persisted, resolved } = carryForward(
      input.carry.base,
      input.carry.files,
    );
    for (const item of persisted) {
      rows.push(
        fromStored(item.finding, input.scanId, FindingStatus.PERSISTED, item),
      );
    }
    for (const finding of resolved) {
      const row = fromStored(finding, input.scanId, FindingStatus.RESOLVED);
      rows.push(row);
      resolvedPool.push(asResolved(row));
    }
    candidates = dropPersistedDuplicates(
      candidates,
      persisted.map((item) => item.finding),
    );
  }

  if (input.match) {
    const { persisted, fresh, resolved } = matchFullAgainstBase(
      candidates,
      input.match.base,
    );
    for (const { candidate, base } of persisted) {
      rows.push(
        fromCandidate(candidate, input.scanId, FindingStatus.PERSISTED, base),
      );
    }
    for (const finding of resolved) {
      const row = fromStored(finding, input.scanId, FindingStatus.RESOLVED);
      rows.push(row);
      resolvedPool.push(asResolved(row));
    }
    candidates = fresh;
  }

  if (input.alreadyPersisted) {
    candidates = dropPersistedDuplicates(candidates, input.alreadyPersisted);
  }

  const newFingerprints: string[] = [];
  for (const { candidate, reopens } of assignNewOrReopened(
    candidates,
    resolvedPool,
  )) {
    if (reopens) {
      rows.push(
        fromCandidate(candidate, input.scanId, FindingStatus.REOPENED, reopens),
      );
    } else {
      rows.push(fromCandidate(candidate, input.scanId, FindingStatus.NEW));
      newFingerprints.push(candidate.fingerprint);
    }
  }
  return { rows, newFingerprints };
}
