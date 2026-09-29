import { createHash } from 'crypto';
import { FindingCategory } from '../../../generated/prisma/enums';
import { AiFindingDraft } from './ai-result-validator';

// AI findings against the static ones of the same scan, then against each
// other. The AI never overrides or removes a static finding; it only adds
// what the rules could not see.

const LINE_SLACK = 2;

export interface StaticForDedupe {
  id: string;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  category: FindingCategory | null;
}

export interface KeptAiFinding extends AiFindingDraft {
  fingerprint: string;
}

export interface DedupeResult {
  kept: KeptAiFinding[];
  // Same file, overlapping lines (±2) and same category as a static finding.
  duplicates: { finding: KeptAiFinding; dedupeOfId: string }[];
}

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

export function dedupeAiFindings(
  findings: AiFindingDraft[],
  staticActive: StaticForDedupe[],
): DedupeResult {
  const result: DedupeResult = { kept: [], duplicates: [] };

  // Among AI findings: one per fingerprint, the most confident.
  const byFingerprint = new Map<string, KeptAiFinding>();
  for (const finding of findings) {
    const fingerprint = aiFingerprint(finding);
    const existing = byFingerprint.get(fingerprint);
    if (!existing || finding.confidence > existing.confidence) {
      byFingerprint.set(fingerprint, { ...finding, fingerprint });
    }
  }

  for (const finding of byFingerprint.values()) {
    const duplicateOf = staticActive.find(
      (s) =>
        s.filePath === finding.filePath &&
        s.category === finding.category &&
        finding.lineStart <= s.lineEnd + LINE_SLACK &&
        finding.lineEnd >= s.lineStart - LINE_SLACK,
    );
    if (duplicateOf) {
      result.duplicates.push({ finding, dedupeOfId: duplicateOf.id });
    } else {
      result.kept.push(finding);
    }
  }
  return result;
}
