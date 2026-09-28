import { minimatch } from 'minimatch';
import {
  IGNORE_GLOBS,
  MUST_SCAN_GLOBS,
  DATA_FIXTURE_GLOBS,
  TEST_FILE_GLOBS,
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

// Inert test data (fixtures/, testdata/). Every rule family is suppressed
// here — see DATA_FIXTURE_GLOBS.
export function isDataFixturePath(filePath: string): boolean {
  return matchesAny(filePath, DATA_FIXTURE_GLOBS);
}

// Config and infrastructure files (`.env`, docker-compose, Dockerfile,
// Terraform, …). Never suppressed as test_file or comment: a credential in
// one — commented out or not — is a real leak in git history.
export function isMustScanPath(filePath: string): boolean {
  return matchesAny(filePath, MUST_SCAN_GLOBS);
}

// Tests, examples and documentation. Whether a finding here is suppressed
// depends on the rule family (src/queue/suppression.ts) — this only answers
// "is this a test-like path".
//
// MUST_SCAN_GLOBS wins: `.env.example` is noise, but `.env` is the
// highest-signal file in the repo, and config/infra files are where real
// credentials get committed even when they sit under a test directory.
export function isTestLikePath(filePath: string): boolean {
  if (isDataFixturePath(filePath)) {
    return true;
  }
  if (isMustScanPath(filePath)) {
    return false;
  }
  return matchesAny(filePath, TEST_FILE_GLOBS);
}
