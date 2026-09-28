import { Prisma } from '../../../generated/prisma/client';
import {
  AiRiskLevel,
  AiScanStatus,
  FindingSeverity,
  FindingSource,
  SuppressionReason,
} from '../../../generated/prisma/enums';
import { KeptAiFinding } from './ai-deduper';

export const SUSPICIOUS_LOW_RISK = 'suspicious_low_risk';

export interface AiResultToPersist {
  status: typeof AiScanStatus.DONE | typeof AiScanStatus.CACHED;
  summaryMd: string;
  riskLevel: AiRiskLevel;
  filesOmitted: string[];
  kept: KeptAiFinding[];
  duplicates: { finding: KeptAiFinding; dedupeOfId: string }[];
  keepDeduped: boolean;
  total: number;
  rejected: number;
  provider: string;
  model: string;
  promptVersion: string;
  tokensIn: number | null;
  tokensOut: number | null;
}

export interface ScanForAi {
  id: string;
  organizationId: string;
  pullId: string;
  // Static active findings — criticalCount is rebuilt as this + AI critical.
  findingsCount: number;
}

export function countBySeverity(findings: KeptAiFinding[]) {
  return {
    critical: findings.filter((f) => f.severity === FindingSeverity.CRITICAL)
      .length,
    major: findings.filter((f) => f.severity === FindingSeverity.MAJOR).length,
    minor: findings.filter((f) => f.severity === FindingSeverity.MINOR).length,
  };
}

// Writes one AI result for a scan, replacing any earlier one (regenerate):
// summary, AI findings, and the scan's AI columns and counts. The scan
// update is conditional on `aiStatusCondition` (e.g. "still RUNNING"), so a
// result nobody is waiting for any more writes nothing. Static findings are
// never touched. Returns false when the condition failed.
export async function persistAiResult(
  tx: Prisma.TransactionClient,
  scan: ScanForAi,
  result: AiResultToPersist,
  aiStatusCondition: Prisma.ScanWhereInput,
): Promise<boolean> {
  const counts = countBySeverity(result.kept);
  const flags =
    result.riskLevel === AiRiskLevel.LOW &&
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
      aiFindingsDeduped: result.duplicates.length,
      aiFlags: flags,
      criticalCount: scan.findingsCount + counts.critical,
      majorCount: counts.major,
      minorCount: counts.minor,
    },
  });
  if (claimed.count === 0) {
    return false;
  }

  await tx.finding.deleteMany({
    where: { scanId: scan.id, source: FindingSource.AI },
  });
  await tx.aiSummary.deleteMany({ where: { scanId: scan.id } });
  await tx.aiSummary.create({
    data: {
      organizationId: scan.organizationId,
      scanId: scan.id,
      pullId: scan.pullId,
      summaryMd: result.summaryMd,
      riskLevel: result.riskLevel,
      filesOmitted: result.filesOmitted,
    },
  });

  const row = (finding: KeptAiFinding) => ({
    organizationId: scan.organizationId,
    scanId: scan.id,
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
    category: finding.category,
    confidence: finding.confidence,
  });
  const rows: Prisma.FindingCreateManyInput[] = result.kept.map((finding) => ({
    ...row(finding),
    suppressedReason: null,
  }));
  if (result.keepDeduped) {
    for (const { finding, dedupeOfId } of result.duplicates) {
      rows.push({
        ...row(finding),
        suppressedReason: SuppressionReason.DEDUPE_STATIC,
        dedupeOfId,
      });
    }
  }
  if (rows.length > 0) {
    await tx.finding.createMany({ data: rows });
  }
  return true;
}
