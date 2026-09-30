import { randomUUID } from 'crypto';
import { Prisma } from '../../../generated/prisma/client';
import {
  AiRiskLevel,
  AiScanStatus,
  DiffMode,
  FindingSeverity,
  FindingSource,
  FindingStatus,
  SuppressionReason,
} from '../../../generated/prisma/enums';
import {
  loadBaseFindings,
  loadRecentResolved,
  STORED_FINDING_SELECT,
} from '../../../queue/lifecycle/lifecycle-context';
import {
  CandidateFinding,
  FindingRow,
  planFindings,
  StoredFinding,
} from '../../../queue/lifecycle/plan-findings';
import {
  recomputeScanCounts,
  ScanCounts,
} from '../../../queue/lifecycle/scan-counts';
import { KeptAiFinding } from './ai-deduper';

export const SUSPICIOUS_LOW_RISK = 'suspicious_low_risk';

// The risk level shown for a PR, from its active findings (static and AI,
// not suppressed, not resolved): a critical → HIGH, a major → MEDIUM,
// otherwise LOW. The model's own risk_level is rated before Critiq drops,
// downgrades, merges and suppresses its findings — left as is, PR #6
// critiq-be showed "RISK · HIGH" next to "0 critical". It is kept on the
// scan (aiReportedRiskLevel), not shown as the PR's risk.
export function riskLevelFromCounts(
  counts: Pick<ScanCounts, 'criticalCount' | 'majorCount'>,
): AiRiskLevel {
  if (counts.criticalCount > 0) {
    return AiRiskLevel.HIGH;
  }
  return counts.majorCount > 0 ? AiRiskLevel.MEDIUM : AiRiskLevel.LOW;
}

type Reader = Pick<Prisma.TransactionClient, 'finding' | 'scan'>;

export interface ScanForAi {
  id: string;
  organizationId: string;
  pullId: string;
  diffMode: DiffMode;
  baseScanId: string | null;
  // Static active findings — for the suspicious_low_risk flag.
  findingsCount: number;
}

// What an AI result needs from the scan's lifecycle (v1.5.1 langkah 3).
export interface AiLifecycleContext {
  // FULL with a base: the base scan's live AI findings, matched by
  // fingerprint.
  baseAi: StoredFinding[];
  // INCREMENTAL: AI findings the static step already carried into this
  // scan — a candidate repeating one is dropped.
  persistedAi: StoredFinding[];
  // RESOLVED rows a candidate may re-open.
  recentResolved: StoredFinding[];
  // The earlier scans that pool came from — for the window-miss log.
  windowScanIds: string[];
}

export async function loadAiLifecycleContext(
  prisma: Reader,
  scan: ScanForAi,
): Promise<AiLifecycleContext> {
  const full = scan.diffMode === DiffMode.FULL;
  const [baseAi, persistedAi, recent] = await Promise.all([
    full && scan.baseScanId
      ? loadBaseFindings(prisma, scan.baseScanId, FindingSource.AI)
      : Promise.resolve([]),
    full
      ? Promise.resolve([])
      : prisma.finding.findMany({
          where: {
            scanId: scan.id,
            source: FindingSource.AI,
            status: FindingStatus.PERSISTED,
          },
          select: STORED_FINDING_SELECT,
        }),
    // In a FULL scan this scan's own AI RESOLVED rows are rewritten by
    // every AI run, so they are not in the pool.
    loadRecentResolved(
      prisma,
      scan.pullId,
      scan.id,
      full ? FindingSource.AI : undefined,
    ),
  ]);
  return {
    baseAi,
    persistedAi,
    recentResolved: recent.rows,
    windowScanIds: recent.windowScanIds,
  };
}

function candidateOf(finding: KeptAiFinding): CandidateFinding {
  return {
    source: FindingSource.AI,
    ruleId: `ai.${finding.category.toLowerCase()}`,
    severity: finding.severity,
    title: finding.title,
    message: finding.message,
    filePath: finding.filePath,
    lineStart: finding.lineStart,
    lineEnd: finding.lineEnd,
    snippet: null,
    fingerprint: finding.fingerprint,
    suppressedReason: finding.suppressedReason,
    category: finding.category,
    confidence: finding.confidence,
    reportedSeverity: finding.reportedSeverity,
  };
}

// Statuses for this AI run's findings: matched against the base (FULL),
// minus what is already persisted (INCREMENTAL), NEW or REOPENED otherwise.
// Duplicates of static findings are kept only with AI_KEEP_DEDUPED, as
// suppressed rows outside the lifecycle.
export function buildAiRows(
  scan: ScanForAi,
  kept: KeptAiFinding[],
  duplicates: { finding: KeptAiFinding; dedupeOfId: string }[],
  context: AiLifecycleContext,
  keepDeduped: boolean,
): { rows: FindingRow[]; newFingerprints: string[] } {
  const plan = planFindings({
    scanId: scan.id,
    candidates: kept.map(candidateOf),
    match:
      scan.diffMode === DiffMode.FULL && context.baseAi.length > 0
        ? { base: context.baseAi }
        : undefined,
    alreadyPersisted:
      scan.diffMode === DiffMode.INCREMENTAL ? context.persistedAi : undefined,
    recentResolved: context.recentResolved,
  });
  const rows = [...plan.rows];
  if (keepDeduped) {
    for (const { finding, dedupeOfId } of duplicates) {
      rows.push({
        ...candidateOf(finding),
        id: randomUUID(),
        suppressedReason: SuppressionReason.DEDUPE_STATIC,
        dedupeOfId,
        status: FindingStatus.NEW,
        firstSeenScanId: scan.id,
        originFindingId: null,
        resolvedInScanId: null,
      });
    }
  }
  return { rows, newFingerprints: plan.newFingerprints };
}

export interface AiResultToPersist {
  status: typeof AiScanStatus.DONE | typeof AiScanStatus.CACHED;
  summaryMd: string;
  // The model's own risk_level; the summary's is recomputed from counts.
  reportedRiskLevel: AiRiskLevel;
  filesOmitted: string[];
  rows: FindingRow[];
  total: number;
  rejected: number;
  // Below the confidence gate: counted, not stored.
  dropped: number;
  deduped: number;
  provider: string;
  model: string;
  promptVersion: string;
  tokensIn: number | null;
  tokensOut: number | null;
}

// Writes one AI result for a scan, replacing an earlier AI run's output
// (regenerate): the scan's AI columns, the AI rows that run produced,
// counts rebuilt from the rows, then the summary with its risk level
// computed from those counts. AI rows the static step
// carried forward (INCREMENTAL: PERSISTED/RESOLVED) are not the AI run's to
// replace. The scan update is conditional on `aiStatusCondition`, so a
// result nobody is waiting for any more writes nothing. Returns the counts,
// or null when the condition failed.
export async function persistAiResult(
  tx: Prisma.TransactionClient,
  scan: ScanForAi,
  result: AiResultToPersist,
  aiStatusCondition: Prisma.ScanWhereInput,
): Promise<ScanCounts | null> {
  const flags =
    result.reportedRiskLevel === AiRiskLevel.LOW &&
    result.total === 0 &&
    scan.findingsCount > 0
      ? [SUSPICIOUS_LOW_RISK]
      : [];

  const claimed = await tx.scan.updateMany({
    where: { id: scan.id, ...aiStatusCondition },
    data: {
      aiStatus: result.status,
      aiErrorCode: null,
      aiRawRef: null,
      aiFinishedAt: new Date(),
      aiProvider: result.provider,
      aiModel: result.model,
      aiPromptVersion: result.promptVersion,
      aiTokensIn: result.tokensIn,
      aiTokensOut: result.tokensOut,
      aiCached: result.status === AiScanStatus.CACHED,
      aiFindingsTotal: result.total,
      aiFindingsRejected: result.rejected,
      aiFindingsDropped: result.dropped,
      aiFindingsDeduped: result.deduped,
      aiReportedRiskLevel: result.reportedRiskLevel,
      aiFlags: flags,
    },
  });
  if (claimed.count === 0) {
    return null;
  }

  await tx.finding.deleteMany({
    where:
      scan.diffMode === DiffMode.INCREMENTAL
        ? {
            scanId: scan.id,
            source: FindingSource.AI,
            OR: [
              { status: { in: [FindingStatus.NEW, FindingStatus.REOPENED] } },
              { suppressedReason: SuppressionReason.DEDUPE_STATIC },
            ],
          }
        : { scanId: scan.id, source: FindingSource.AI },
  });
  if (result.rows.length > 0) {
    await tx.finding.createMany({
      data: result.rows.map((row) => ({
        ...row,
        organizationId: scan.organizationId,
        scanId: scan.id,
        pullId: scan.pullId,
      })),
    });
  }
  const counts = await recomputeScanCounts(tx, scan.id);

  await tx.aiSummary.deleteMany({ where: { scanId: scan.id } });
  await tx.aiSummary.create({
    data: {
      organizationId: scan.organizationId,
      scanId: scan.id,
      pullId: scan.pullId,
      summaryMd: result.summaryMd,
      // Rated against the findings as stored, not as the model reported them.
      riskLevel: riskLevelFromCounts(counts),
      filesOmitted: result.filesOmitted,
    },
  });
  return counts;
}

// AI criticals this run brought (NEW) or brought back (REOPENED).
export function freshCriticalCount(rows: FindingRow[]): number {
  return rows.filter(
    (row) =>
      row.suppressedReason === null &&
      row.severity === FindingSeverity.CRITICAL &&
      (row.status === FindingStatus.NEW ||
        row.status === FindingStatus.REOPENED),
  ).length;
}
