import { jaroWinkler, normalizeTitle } from '../../common/text/jaro-winkler';

// Status assignment for this scan's fresh candidates (v1.5.1 langkah 3).

export const REOPEN_WINDOW_SCANS = 3;
const REOPEN_LINE_DISTANCE = 5;
const REOPEN_TITLE_SIMILARITY = 0.85;

export interface MatchableFinding {
  source: string;
  filePath: string;
  lineStart: number;
  category: string | null;
  title: string;
  fingerprint: string;
}

export interface ResolvedFinding extends MatchableFinding {
  id: string;
  firstSeenScanId: string;
}

// A rule/model re-finding something already carried as PERSISTED (a hunk
// next to it made its line reachable again) must not count twice.
export function dropPersistedDuplicates<T extends { fingerprint: string }>(
  candidates: T[],
  persisted: { fingerprint: string }[],
): T[] {
  const known = new Set(persisted.map((finding) => finding.fingerprint));
  return candidates.filter((candidate) => !known.has(candidate.fingerprint));
}

// The same finding reported again, by fingerprint or — fingerprints differ
// when the wording does — the same kind of problem at about the same place
// with a very similar title. Exact matches are to be preferred over similar
// ones by the caller.
export function isSameFinding(
  a: MatchableFinding,
  b: MatchableFinding,
): boolean {
  return (
    a.fingerprint === b.fingerprint ||
    (a.source === b.source &&
      a.filePath === b.filePath &&
      a.category === b.category &&
      Math.abs(a.lineStart - b.lineStart) <= REOPEN_LINE_DISTANCE &&
      jaroWinkler(normalizeTitle(a.title), normalizeTitle(b.title)) >=
        REOPEN_TITLE_SIMILARITY)
  );
}

// The resolved finding a candidate re-opens, or null when it is new. Exact
// fingerprint first; otherwise the same kind of problem at about the same
// place with a very similar title — how an AI re-reports a partial fix.
export function findReopened(
  candidate: MatchableFinding,
  resolved: ResolvedFinding[],
): ResolvedFinding | null {
  return (
    resolved.find((r) => r.fingerprint === candidate.fingerprint) ??
    resolved.find((r) => isSameFinding(candidate, r)) ??
    null
  );
}

// NEW or REOPENED for each candidate; each resolved finding re-opens at most
// one candidate.
export function assignNewOrReopened<T extends MatchableFinding>(
  candidates: T[],
  resolved: ResolvedFinding[],
): { candidate: T; reopens: ResolvedFinding | null }[] {
  const pool = [...resolved];
  return candidates.map((candidate) => {
    const match = findReopened(candidate, pool);
    if (match) {
      pool.splice(pool.indexOf(match), 1);
    }
    return { candidate, reopens: match };
  });
}

// FULL scan with a base (force-push, ruleset/prompt change, manual): no
// diff to map through, so identity is the fingerprint. A candidate matching
// an active base finding continues it (PERSISTED, at the candidate's new
// lines); base findings nobody matched are RESOLVED.
export function matchFullAgainstBase<
  C extends { fingerprint: string },
  B extends { fingerprint: string },
>(
  candidates: C[],
  base: B[],
): { persisted: { candidate: C; base: B }[]; fresh: C[]; resolved: B[] } {
  const pool = new Map<string, B[]>();
  for (const finding of base) {
    const list = pool.get(finding.fingerprint) ?? [];
    list.push(finding);
    pool.set(finding.fingerprint, list);
  }
  const persisted: { candidate: C; base: B }[] = [];
  const fresh: C[] = [];
  for (const candidate of candidates) {
    const match = pool.get(candidate.fingerprint)?.shift();
    if (match) {
      persisted.push({ candidate, base: match });
    } else {
      fresh.push(candidate);
    }
  }
  const resolved = [...pool.values()].flat();
  return { persisted, fresh, resolved };
}
