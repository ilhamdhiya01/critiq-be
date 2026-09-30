import {
  FindingCategory,
  FindingSeverity,
  FindingSource,
  FindingStatus,
  SuppressionReason,
} from '../../../generated/prisma/enums';
import { ApiFindingCategory, toApiCategory } from './ai-scan-fields';
import { ApiFindingStatus, toApiFindingStatus } from './lifecycle-fields';

// Lowercase on the wire, matching the PRD's API examples; the Prisma enum
// stays uppercase like every other enum in the schema.
export type ApiSuppressionReason =
  'test_file' | 'comment' | 'regex_literal' | 'dedupe_static';

export function toApiSuppressionReason(
  reason: SuppressionReason | null,
): ApiSuppressionReason | null {
  switch (reason) {
    case SuppressionReason.TEST_FILE:
      return 'test_file';
    case SuppressionReason.COMMENT:
      return 'comment';
    case SuppressionReason.DEDUPE_STATIC:
      return 'dedupe_static';
    case SuppressionReason.REGEX_LITERAL:
      return 'regex_literal';
    default:
      return null;
  }
}

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
  // null = active. Set = stored for visibility only: not counted, no
  // notification, no diff annotation.
  suppressedReason!: ApiSuppressionReason | null;
  // Shared by static and AI findings (static: from the rule id).
  category!: ApiFindingCategory | null;
  // AI findings only.
  confidence!: number | null;
  // AI findings only, and only when Critiq's calibration changed what the
  // model reported (confidence downgrade, hedged title): its own severity.
  meta!: { reportedSeverity: FindingSeverity } | null;
  // Lifecycle across the PR's pushes (v1.5.1 langkah 3).
  status!: ApiFindingStatus;
  firstSeenScanId!: string | null;
  originFindingId!: string | null;
  resolvedInScanId!: string | null;

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
    suppressedReason: SuppressionReason | null;
    category?: FindingCategory | null;
    // Prisma Decimal, or a plain number.
    confidence?: { toNumber(): number } | number | null;
    reportedSeverity?: FindingSeverity | null;
    status?: FindingStatus;
    firstSeenScanId?: string | null;
    originFindingId?: string | null;
    resolvedInScanId?: string | null;
  }) {
    const { confidence, category, status, reportedSeverity, ...rest } = partial;
    Object.assign(this, {
      firstSeenScanId: null,
      originFindingId: null,
      resolvedInScanId: null,
      ...rest,
      status: toApiFindingStatus(status ?? FindingStatus.NEW),
      suppressedReason: toApiSuppressionReason(partial.suppressedReason),
      category: toApiCategory(category ?? null),
      meta:
        reportedSeverity && reportedSeverity !== partial.severity
          ? { reportedSeverity }
          : null,
      confidence:
        confidence == null
          ? null
          : typeof confidence === 'number'
            ? confidence
            : confidence.toNumber(),
    });
  }
}
