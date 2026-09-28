import {
  FindingCategory,
  FindingSeverity,
  FindingSource,
  SuppressionReason,
} from '../../../generated/prisma/enums';
import { ApiFindingCategory, toApiCategory } from './ai-scan-fields';

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
  }) {
    const { confidence, category, ...rest } = partial;
    Object.assign(this, {
      ...rest,
      suppressedReason: toApiSuppressionReason(partial.suppressedReason),
      category: toApiCategory(category ?? null),
      confidence:
        confidence == null
          ? null
          : typeof confidence === 'number'
            ? confidence
            : confidence.toNumber(),
    });
  }
}
