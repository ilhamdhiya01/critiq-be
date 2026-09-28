import { createHash } from 'crypto';
import { SuppressionReason } from '../generated/prisma/enums';
import { RuleHit } from './rules/rule-runner';

export interface LocatedHit extends RuleHit {
  filePath: string;
  suppressedReason?: SuppressionReason | null;
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
  suppressedReason: SuppressionReason | null;
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
//
// Suppression: hits carry the reason the processor assigned. When the same
// fingerprint appears both active and suppressed, the active one wins and the
// line range covers only the active occurrences — a real hit must never be
// hidden because a copy of it also sits in a regex on another line.
export function dedupeFindings(hits: LocatedHit[]): PreparedFinding[] {
  interface Group {
    base: LocatedHit;
    fingerprint: string;
    active: { lineStart: number; lineEnd: number; count: number } | null;
    suppressed: {
      lineStart: number;
      lineEnd: number;
      count: number;
      reason: SuppressionReason;
    } | null;
  }
  const groups = new Map<string, Group>();

  for (const hit of hits) {
    const key = hit.identity
      ? `id:${hit.identity.key}:${hit.identity.valuePrefix}:${hit.identity.valueLength}`
      : hit.snippet === null || hit.ruleId.startsWith('secret.')
        ? `line:${hit.lineStart}`
        : hit.snippet.trim().replace(/\s+/g, ' ');

    const fingerprint = createHash('sha1')
      .update(`${hit.ruleId}\0${hit.filePath}\0${key}`)
      .digest('hex');

    let group = groups.get(fingerprint);
    if (!group) {
      group = { base: hit, fingerprint, active: null, suppressed: null };
      groups.set(fingerprint, group);
    }

    const reason = hit.suppressedReason ?? null;
    if (reason === null) {
      if (!group.active) {
        group.base = hit;
        group.active = {
          lineStart: hit.lineStart,
          lineEnd: hit.lineEnd,
          count: 0,
        };
      }
      group.active.lineStart = Math.min(group.active.lineStart, hit.lineStart);
      group.active.lineEnd = Math.max(group.active.lineEnd, hit.lineEnd);
      group.active.count += 1;
    } else {
      if (!group.suppressed) {
        group.suppressed = {
          lineStart: hit.lineStart,
          lineEnd: hit.lineEnd,
          count: 0,
          reason,
        };
      }
      group.suppressed.lineStart = Math.min(
        group.suppressed.lineStart,
        hit.lineStart,
      );
      group.suppressed.lineEnd = Math.max(
        group.suppressed.lineEnd,
        hit.lineEnd,
      );
      group.suppressed.count += 1;
    }
  }

  const findings: PreparedFinding[] = [];
  for (const group of groups.values()) {
    const kept = group.active ?? group.suppressed;
    if (!kept) {
      continue;
    }
    // The count goes on `message`, not `title`: title is VarChar(120) and a
    // suffix could push a long rule title past it.
    const message =
      kept.count > 1
        ? `${group.base.message} (muncul di ${kept.count} baris)`
        : group.base.message;
    findings.push({
      ruleId: group.base.ruleId,
      title: group.base.title,
      message,
      filePath: group.base.filePath,
      lineStart: kept.lineStart,
      lineEnd: kept.lineEnd,
      snippet: group.base.snippet,
      fingerprint: group.fingerprint,
      suppressedReason: group.active
        ? null
        : (group.suppressed?.reason ?? null),
    });
  }
  return findings;
}
