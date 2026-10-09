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

export interface FindingMeta {
  reportedSeverity?: FindingSeverity;
  severityChanged?: { previous: FindingSeverity; latest: FindingSeverity };
  notReproduced?: true;
}

function metaOf(finding: {
  severity: FindingSeverity;
  reportedSeverity?: FindingSeverity | null;
  previousRunSeverity?: FindingSeverity | null;
  latestRunSeverity?: FindingSeverity | null;
  notReproduced?: boolean;
}): FindingMeta | null {
  const meta: FindingMeta = {};
  if (
    finding.reportedSeverity &&
    finding.reportedSeverity !== finding.severity
  ) {
    meta.reportedSeverity = finding.reportedSeverity;
  }
  if (finding.previousRunSeverity && finding.latestRunSeverity) {
    meta.severityChanged = {
      previous: finding.previousRunSeverity,
      latest: finding.latestRunSeverity,
    };
  }
  if (finding.notReproduced) {
    meta.notReproduced = true;
  }
  return Object.keys(meta).length > 0 ? meta : null;
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
  // AI findings only; null when there is nothing to say. Each key only when
  // it applies:
  //  - reportedSeverity: Critiq's calibration (confidence downgrade, hedged
  //    title) changed what the model reported — the model's own severity;
  //  - severityChanged: two AI runs on the same commit rated it differently
  //    (regenerate); `severity` is the higher, these are each run's;
  //  - notReproduced: an earlier run on the same commit reported it, the
  //    latest did not — still counted, a reviewer decides.
  meta!: FindingMeta | null;
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
    previousRunSeverity?: FindingSeverity | null;
    latestRunSeverity?: FindingSeverity | null;
    notReproduced?: boolean;
    status?: FindingStatus;
    firstSeenScanId?: string | null;
    originFindingId?: string | null;
    resolvedInScanId?: string | null;
  }) {
    const {
      confidence,
      category,
      status,
      reportedSeverity,
      previousRunSeverity,
      latestRunSeverity,
      notReproduced,
      ...rest
    } = partial;
    Object.assign(this, {
      firstSeenScanId: null,
      originFindingId: null,
      resolvedInScanId: null,
      ...rest,
      status: toApiFindingStatus(status ?? FindingStatus.NEW),
      suppressedReason: toApiSuppressionReason(partial.suppressedReason),
      category: toApiCategory(category ?? null),
      meta: metaOf({
        severity: partial.severity,
        reportedSeverity,
        previousRunSeverity,
        latestRunSeverity,
        notReproduced,
      }),
      confidence:
        confidence == null
          ? null
          : typeof confidence === 'number'
            ? confidence
            : confidence.toNumber(),
    });
  }
}
