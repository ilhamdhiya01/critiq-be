import { createHash } from 'crypto';
import { RuleHit } from './rules/rule-runner';

export interface LocatedHit extends RuleHit {
  filePath: string;
}

export interface PreparedFinding {
  ruleId: string;
  title: string;
  message: string;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  snippet: string | null;
  fingerprint: string;
}

// One finding per distinct issue, with the line range widened to span every
// occurrence in the file.
//
// The fingerprint has two shapes, and which one applies decides whether two
// hits merge:
//
//  - When the rule reported an `identity` (key + 4-char prefix + exact
//    length), that is the key. The same credential repeated down a .env
//    file becomes one finding; two *different* credentials under the same
//    key name, sharing a prefix AND a length, would have to collide on all
//    three to merge wrongly — vanishingly unlikely.
//
//  - Without an identity there is nothing to tell two values apart. The
//    snippet cannot serve: secret snippets are masked, so every AWS key
//    reads "AKIA****", and merging on that would turn two separate leaks
//    on lines 3 and 40 into one misleading 3–40 finding. Those fall back
//    to the line number, which never merges — the conservative choice.
//
// Nothing here hashes the credential itself. A prefix and a length are
// strictly weaker than the `snippet` already persisted alongside, which is
// why the old comment's objection to storing "an unsalted hash of the
// secret" does not apply to this scheme.
export function dedupeFindings(hits: LocatedHit[]): PreparedFinding[] {
  const byFingerprint = new Map<string, PreparedFinding>();
  const occurrences = new Map<string, number>();

  for (const hit of hits) {
    const key = hit.identity
      ? `id:${hit.identity.key}:${hit.identity.valuePrefix}:${hit.identity.valueLength}`
      : hit.snippet === null || hit.ruleId.startsWith('secret.')
        ? `line:${hit.lineStart}`
        : hit.snippet.trim().replace(/\s+/g, ' ');

    const fingerprint = createHash('sha1')
      .update(`${hit.ruleId}\0${hit.filePath}\0${key}`)
      .digest('hex');

    occurrences.set(fingerprint, (occurrences.get(fingerprint) ?? 0) + 1);

    const existing = byFingerprint.get(fingerprint);
    if (existing) {
      existing.lineStart = Math.min(existing.lineStart, hit.lineStart);
      existing.lineEnd = Math.max(existing.lineEnd, hit.lineEnd);
      continue;
    }
    byFingerprint.set(fingerprint, {
      ruleId: hit.ruleId,
      title: hit.title,
      message: hit.message,
      filePath: hit.filePath,
      lineStart: hit.lineStart,
      lineEnd: hit.lineEnd,
      snippet: hit.snippet,
      fingerprint,
    });
  }

  // The count goes on `message`, not `title`: title is VarChar(120) and a
  // suffix could push a long rule title past it.
  for (const [fingerprint, finding] of byFingerprint) {
    const count = occurrences.get(fingerprint) ?? 1;
    if (count > 1) {
      finding.message = `${finding.message} (muncul di ${count} baris)`;
    }
  }

  return [...byFingerprint.values()];
}
