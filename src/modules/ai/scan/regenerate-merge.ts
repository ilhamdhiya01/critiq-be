import { randomUUID } from 'crypto';
import {
  FindingSeverity,
  FindingSource,
  FindingStatus,
} from '../../../generated/prisma/enums';
import {
  FindingRow,
  StoredFinding,
} from '../../../queue/lifecycle/plan-findings';
import { isSameFinding } from '../../../queue/lifecycle/status-matcher';

// A model is not deterministic: regenerating the same commit can rate a
// finding critical once and major the next time, or not report it at all.
// When the earlier run is comparable — same commit, provider, model and
// prompt — its findings are merged into the new run instead of being
// replaced: matched findings keep the higher severity (both runs' own are
// recorded), unmatched earlier ones are kept as notReproduced and still
// counted. A critical that silently vanishes is the dangerous kind of
// noise; a reviewer decides (dismiss arrives in v1.5.2).

// An earlier run's active (not suppressed, not resolved) AI finding.
export type PreviousRunFinding = StoredFinding & {
  // Present for the same scan's own rows (regenerate): kept on a carried
  // row. Absent for a base scan's rows (rescan of the same commit).
  status?: FindingStatus;
  originFindingId?: string | null;
};

// 'same_scan': regenerate — the earlier rows are this scan's, about to be
// replaced. 'base_scan': a new scan of the same commit — the earlier rows
// are the base scan's, which the lifecycle would otherwise mark RESOLVED.
export type PreviousRunKind = 'same_scan' | 'base_scan';

export interface MergeStats {
  matched: number;
  // Matched, and the earlier run rated it higher than this one.
  escalated: number;
  notReproduced: number;
}

export interface RunIdentity {
  provider: string | null;
  model: string | null;
  promptVersion: string | null;
}

// A provider answers with the model it actually ran — OpenAI a dated
// snapshot (gpt-4o-mini → gpt-4o-mini-2024-07-18) — while the request
// names the alias. A plain prefix test would equate gpt-4o and gpt-4o-mini.
function modelFamily(model: string): string {
  return model.replace(/-(\d{4}-\d{2}-\d{2}|\d{8})$/, '');
}

export function isComparableRun(
  earlier: RunIdentity,
  current: RunIdentity,
): boolean {
  return (
    earlier.provider !== null &&
    earlier.provider === current.provider &&
    earlier.promptVersion !== null &&
    earlier.promptVersion === current.promptVersion &&
    earlier.model !== null &&
    current.model !== null &&
    modelFamily(earlier.model) === modelFamily(current.model)
  );
}

const SEVERITY_RANK: Record<FindingSeverity, number> = {
  [FindingSeverity.CRITICAL]: 3,
  [FindingSeverity.MAJOR]: 2,
  [FindingSeverity.MINOR]: 1,
  [FindingSeverity.INFO]: 0,
};

function higher(a: FindingSeverity, b: FindingSeverity): FindingSeverity {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

function confidenceOf(value: StoredFinding['confidence']): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  return typeof value === 'number' ? value : value.toNumber();
}

function isActiveAi(row: FindingRow): boolean {
  return (
    row.source === FindingSource.AI &&
    row.status !== FindingStatus.RESOLVED &&
    !row.suppressedReason
  );
}

function carried(
  earlier: PreviousRunFinding,
  kind: PreviousRunKind,
): FindingRow {
  return {
    id: randomUUID(),
    source: earlier.source,
    ruleId: earlier.ruleId,
    severity: earlier.severity,
    title: earlier.title,
    message: earlier.message,
    filePath: earlier.filePath,
    lineStart: earlier.lineStart,
    lineEnd: earlier.lineEnd,
    snippet: earlier.snippet,
    fingerprint: earlier.fingerprint,
    suppressedReason: null,
    category: earlier.category,
    confidence: confidenceOf(earlier.confidence),
    reportedSeverity: earlier.reportedSeverity ?? null,
    dedupeOfId: null,
    previousRunSeverity: earlier.previousRunSeverity ?? null,
    latestRunSeverity: earlier.latestRunSeverity ?? null,
    notReproduced: true,
    // Same scan: the row is the same finding, rewritten. Base scan: it is
    // continued into the new scan, like any persisted finding.
    status:
      kind === 'same_scan'
        ? (earlier.status ?? FindingStatus.NEW)
        : FindingStatus.PERSISTED,
    firstSeenScanId: earlier.firstSeenScanId,
    originFindingId:
      kind === 'same_scan' ? (earlier.originFindingId ?? null) : earlier.id,
    resolvedInScanId: null,
  };
}

export function mergeWithPreviousRun(
  rows: FindingRow[],
  previous: PreviousRunFinding[],
  kind: PreviousRunKind,
): { rows: FindingRow[]; stats: MergeStats } {
  const stats: MergeStats = { matched: 0, escalated: 0, notReproduced: 0 };
  const unused = new Map(previous.map((finding) => [finding.id, finding]));
  // Base scan: an earlier finding this run did not repeat was marked
  // RESOLVED by the lifecycle — it is carried as notReproduced instead.
  const own =
    kind === 'base_scan'
      ? rows.filter(
          (row) =>
            !(
              row.status === FindingStatus.RESOLVED &&
              row.originFindingId &&
              unused.has(row.originFindingId)
            ),
        )
      : rows;

  const merged: FindingRow[] = [];
  for (const row of own) {
    if (!isActiveAi(row)) {
      merged.push(row);
      continue;
    }
    const candidates = [...unused.values()];
    const match =
      // The lifecycle already linked them (base scan, same fingerprint).
      (row.originFindingId ? unused.get(row.originFindingId) : undefined) ??
      candidates.find((earlier) => earlier.fingerprint === row.fingerprint) ??
      candidates.find((earlier) =>
        isSameFinding(
          {
            source: row.source,
            filePath: row.filePath,
            lineStart: row.lineStart,
            category: row.category ?? null,
            title: row.title,
            fingerprint: row.fingerprint,
          },
          earlier,
        ),
      );
    if (!match) {
      merged.push(row);
      continue;
    }
    unused.delete(match.id);
    stats.matched += 1;
    // Base scan, matched by similarity rather than fingerprint: it is the
    // base finding continued, not a new one.
    const lifecycle =
      kind === 'base_scan' && row.originFindingId !== match.id
        ? {
            status: FindingStatus.PERSISTED,
            originFindingId: match.id,
            firstSeenScanId: match.firstSeenScanId,
          }
        : {};
    if (match.severity === row.severity) {
      // Agreeing now does not erase an earlier disagreement.
      merged.push({
        ...row,
        ...lifecycle,
        previousRunSeverity: match.previousRunSeverity ?? null,
        latestRunSeverity: match.latestRunSeverity ?? null,
      });
      continue;
    }
    const severity = higher(match.severity, row.severity);
    if (severity !== row.severity) {
      stats.escalated += 1;
    }
    merged.push({
      ...row,
      ...lifecycle,
      severity,
      previousRunSeverity: match.severity,
      latestRunSeverity: row.severity,
    });
  }
  for (const earlier of unused.values()) {
    stats.notReproduced += 1;
    merged.push(carried(earlier, kind));
  }
  return { rows: merged, stats };
}
