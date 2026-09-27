import { minimatch } from 'minimatch';
import {
  IGNORE_GLOBS,
  MUST_SCAN_GLOBS,
  SECRET_SKIP_GLOBS,
} from './rules.constants';

// `dot: true` is not optional here: without it minimatch refuses to let any
// wildcard match a leading-dot segment, so `.env` — the single most likely
// place for a committed credential — would never match `**/.env`, and
// `.github/workflows/*.yml` would never be scanned at all.
//
// `nocase: true` preserves the previous hand-rolled matcher's behaviour
// (`assets/Logo.PNG` was ignored via a lowercased basename compare) and is
// the safer default for a skip list: a rule missing because someone wrote
// `.ENV` is worse than one extra file scanned.
const MATCH_OPTIONS = { dot: true, nocase: true } as const;

function matchesAny(filePath: string, globs: string[]): boolean {
  return globs.some((glob) => minimatch(filePath, glob, MATCH_OPTIONS));
}

// Generated, vendored or binary content — skipped before any rule runs, and
// excluded from the scan's diffBytes total so a lockfile bump alone can't
// push a normal PR over SCAN_MAX_DIFF_BYTES.
export function isIgnoredPath(
  filePath: string,
  globs: string[] = IGNORE_GLOBS,
): boolean {
  return matchesAny(filePath, globs);
}

// Skipped for `secret.*` rules only — `code.*` and `config.*` still run.
//
// Applied per rule in the runner rather than up front in the processor,
// because these files are legitimately scannable for everything else: a
// README or a test fixture is where example credentials *belong*, but real
// bugs in test helpers still matter. Keeping the split also leaves
// diffBytes (computed from the processor's filter) unchanged.
//
// MUST_SCAN_GLOBS wins over SECRET_SKIP_GLOBS: `.env.example` is noise, but
// `.env` is the highest-signal file in the repo, and a naive `*.env*` style
// skip would swallow it.
export function isSecretSkippedPath(filePath: string): boolean {
  if (matchesAny(filePath, MUST_SCAN_GLOBS)) {
    return false;
  }
  return matchesAny(filePath, SECRET_SKIP_GLOBS);
}
