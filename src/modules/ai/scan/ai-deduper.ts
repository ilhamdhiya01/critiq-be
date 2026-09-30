import { createHash } from 'crypto';
import {
  FindingCategory,
  SuppressionReason,
} from '../../../generated/prisma/enums';
import { jaroWinkler } from '../../../common/text/jaro-winkler';
import { classifySuppression } from '../../../queue/suppression';
import { AiFindingDraft } from './ai-result-validator';

// AI findings against each other, then against the static ones of the same
// scan. The AI never overrides or removes a static finding; it only adds
// what the rules could not see — and it does not get around what the rules
// deliberately set aside: an AI finding is suppressed where a static one
// would be.

const LINE_SLACK = 2;
// Two AI findings in the same file and category whose titles are this
// similar describe one problem (same bar as reopening a resolved finding).
const SIMILAR_TITLE = 0.85;
// A merge never widens a finding past the validator's own range limit.
const MAX_MERGED_RANGE = 40;
// Stripped before fingerprinting: "Potential missing X" and "Missing X"
// are the same finding.
const HEDGE_PREFIX = /^(potential|possible|may|might)\s+/i;

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
  // AI findings folded into another AI finding (same fingerprint, or a
  // near-identical title in the same file and category).
  merged: number;
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
    .trim()
    .replace(HEDGE_PREFIX, '')
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

// One finding per root cause (severity calibration): the model often
// reports the same problem on nearby lines with different wording. Most
// confident first; each later finding folds into the first it matches —
// same fingerprint always, a similar title when the merged range stays
// within MAX_MERGED_RANGE. The kept finding's text, severity and
// fingerprint win; its range grows to cover both.
function mergeAiFindings(findings: AiFindingDraft[]): {
  merged: KeptAiFinding[];
  folded: number;
} {
  const merged: KeptAiFinding[] = [];
  let folded = 0;
  const byConfidence = [...findings].sort(
    (a, b) => b.confidence - a.confidence,
  );
  for (const finding of byConfidence) {
    const fingerprint = aiFingerprint(finding);
    const title = normalizeTitle(finding.title);
    const range = (kept: KeptAiFinding) =>
      Math.max(kept.lineEnd, finding.lineEnd) -
      Math.min(kept.lineStart, finding.lineStart);
    const into = merged.find(
      (kept) =>
        kept.fingerprint === fingerprint ||
        (kept.filePath === finding.filePath &&
          kept.category === finding.category &&
          range(kept) <= MAX_MERGED_RANGE &&
          jaroWinkler(normalizeTitle(kept.title), title) >= SIMILAR_TITLE),
    );
    if (!into) {
      merged.push({ ...finding, fingerprint, suppressedReason: null });
      continue;
    }
    folded += 1;
    if (range(into) <= MAX_MERGED_RANGE) {
      into.lineStart = Math.min(into.lineStart, finding.lineStart);
      into.lineEnd = Math.max(into.lineEnd, finding.lineEnd);
    }
  }
  return { merged, folded };
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
  const { merged, folded } = mergeAiFindings(findings);
  const result: DedupeResult = { kept: [], merged: folded, duplicates: [] };
  const staticActive = staticFindings.filter(
    (s) => s.suppressedReason === null,
  );
  const staticSuppressed = staticFindings.filter(
    (s) => s.suppressedReason !== null,
  );

  for (const finding of merged) {
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
