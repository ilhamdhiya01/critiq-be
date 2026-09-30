import { createHash } from 'crypto';
import {
  FindingCategory,
  SuppressionReason,
} from '../../../generated/prisma/enums';
import { classifySuppression } from '../../../queue/suppression';
import { AiFindingDraft } from './ai-result-validator';

// AI findings against the static ones of the same scan, then against each
// other. The AI never overrides or removes a static finding; it only adds
// what the rules could not see — and it does not get around what the rules
// deliberately set aside: an AI finding is suppressed where a static one
// would be.

const LINE_SLACK = 2;

export interface StaticForDedupe {
  id: string;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  category: FindingCategory | null;
  suppressedReason: SuppressionReason | null;
}

export interface KeptAiFinding extends AiFindingDraft {
  fingerprint: string;
  // Stored, but not counted or notified — as for static findings.
  suppressedReason: SuppressionReason | null;
}

export interface DedupeResult {
  kept: KeptAiFinding[];
  // Same file, overlapping lines (±2) and same category as an active static
  // finding.
  duplicates: { finding: KeptAiFinding; dedupeOfId: string }[];
}

// The static rule family an AI category belongs to, for the path-based
// suppression rules (suppression.ts): secrets and config are set aside in
// test files like `secret.*` / `config.*`; eval, SQL and shell findings in
// tests stay active, as the rules' do. Fixtures suppress every family.
const FAMILY_RULE_ID: Partial<Record<FindingCategory, string>> = {
  [FindingCategory.SECRET]: 'secret.ai',
  [FindingCategory.CONFIG]: 'config.ai',
  [FindingCategory.INSECURE_TLS]: 'code.insecure_tls',
};

function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function aiFingerprint(finding: AiFindingDraft): string {
  return createHash('sha1')
    .update(
      `ai|${finding.filePath}|${finding.category}|${normalizeTitle(finding.title)}`,
    )
    .digest('hex');
}

function overlaps(finding: KeptAiFinding, other: StaticForDedupe): boolean {
  return (
    other.filePath === finding.filePath &&
    other.category === finding.category &&
    finding.lineStart <= other.lineEnd + LINE_SLACK &&
    finding.lineEnd >= other.lineStart - LINE_SLACK
  );
}

// Why a finding kept after dedupe is suppressed: the reason of a suppressed
// static finding it overlaps (the model saw the same commented-out key or
// regex), else the path rules — no line/column, so only test_file applies.
function suppressionFor(
  finding: KeptAiFinding,
  suppressedStatic: StaticForDedupe[],
): SuppressionReason | null {
  const inherited = suppressedStatic.find((s) => overlaps(finding, s));
  if (inherited) {
    return inherited.suppressedReason;
  }
  return classifySuppression({
    ruleId:
      FAMILY_RULE_ID[finding.category] ??
      `ai.${finding.category.toLowerCase()}`,
    filePath: finding.filePath,
    language: '',
  });
}

export function dedupeAiFindings(
  findings: AiFindingDraft[],
  staticFindings: StaticForDedupe[],
): DedupeResult {
  const result: DedupeResult = { kept: [], duplicates: [] };
  const staticActive = staticFindings.filter(
    (s) => s.suppressedReason === null,
  );
  const staticSuppressed = staticFindings.filter(
    (s) => s.suppressedReason !== null,
  );

  // Among AI findings: one per fingerprint, the most confident.
  const byFingerprint = new Map<string, KeptAiFinding>();
  for (const finding of findings) {
    const fingerprint = aiFingerprint(finding);
    const existing = byFingerprint.get(fingerprint);
    if (!existing || finding.confidence > existing.confidence) {
      byFingerprint.set(fingerprint, {
        ...finding,
        fingerprint,
        suppressedReason: null,
      });
    }
  }

  for (const finding of byFingerprint.values()) {
    const duplicateOf = staticActive.find((s) => overlaps(finding, s));
    if (duplicateOf) {
      result.duplicates.push({ finding, dedupeOfId: duplicateOf.id });
    } else {
      result.kept.push({
        ...finding,
        suppressedReason: suppressionFor(finding, staticSuppressed),
      });
    }
  }
  return result;
}
