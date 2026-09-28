// Bumped whenever the rules change what they would find on the same diff.
// ScanQueueService compares a PR's last scan against this and re-scans when
// they differ, so a bump makes every open PR's next webhook produce fresh
// results instead of serving a verdict the old rules reached.
export const RULESET_VERSION = '2026.09.4';

// Paths matching any of these are skipped entirely before any rule runs:
// generated/vendored/binary content a rule could never meaningfully flag.
// Matched by path-filter.ts with minimatch ({ dot: true, nocase: true }),
// so every entry must be a full-path glob — `**/` prefixes are load-bearing,
// since a bare `*.png` only matches at the repo root.
export const IGNORE_GLOBS = [
  '**/*.lock',
  // npm/pnpm lockfiles don't end in .lock, but are just as generated and
  // routinely hundreds of KB — without these a dependency bump alone could
  // push a normal PR over SCAN_MAX_DIFF_BYTES.
  '**/package-lock.json',
  '**/pnpm-lock.yaml',
  '**/*.min.js',
  '**/*.map',
  '**/dist/**',
  'dist/**',
  '**/build/**',
  'build/**',
  '**/node_modules/**',
  'node_modules/**',
  '**/vendor/**',
  'vendor/**',
  '**/.git/**',
  '.git/**',
  '**/*.snap',
  '**/*.svg',
  '**/*.png',
  '**/*.jpg',
  '**/*.jpeg',
  '**/*.gif',
  '**/*.ico',
  '**/*.woff',
  '**/*.woff2',
  '**/*.pdf',
];

// Test files, fixtures and documentation: findings here are stored but
// SUPPRESSED with reason TEST_FILE (see src/queue/suppression.ts for which
// rule families it applies to), never dropped — a real secret committed to a
// spec file must still be visible to an Admin, just not counted or notified.
export const TEST_FILE_GLOBS = [
  '**/*.test.*',
  '**/*.spec.*',
  '**/*_test.*',
  '**/test_*.py',
  '**/__tests__/**',
  '**/__mocks__/**',
  '**/fixtures/**',
  '**/testdata/**',
  '**/test/**',
  '**/tests/**',
  '**/spec/**',
  '**/e2e/**',
  '**/*.example',
  '**/*.example.*',
  '**/*.sample',
  '**/*.sample.*',
  '**/*.template',
  '**/*.dist',
  '**/*.md',
  '**/*.mdx',
  '**/*.rst',
  '**/*.stories.*',
  '**/*.snap',
  // Shared test scaffolding that is not itself a spec. Holds fixture values
  // on purpose (e.g. src/queue/rules/test-helpers.ts assembles the fake
  // provider tokens) and is only ever imported by specs.
  '**/test-helpers.*',
  '**/test-utils.*',
  '**/test_helpers.*',
  '**/test_utils.*',
  // `*.txt` is deliberately NOT here, although the v1.5.0 delta listed it with
  // the other prose formats: a private key pasted into `key.txt` or
  // `credentials.txt` is a real and common way to leak one, and suppressing
  // the extension would hide exactly that.
];

// Subset of TEST_FILE_GLOBS that is inert data, never executed: every rule
// family is suppressed here, including code.eval_dynamic / sql_string_concat
// / shell_injection, which stay active in *.spec.* files because that code
// actually runs in CI.
export const DATA_FIXTURE_GLOBS = ['**/fixtures/**', '**/testdata/**'];

// Overrides TEST_FILE_GLOBS — a file matching both is never suppressed as a
// test file (e.g. `test/fixtures-free/docker-compose.yml`, `e2e/.env`).
// Config and infrastructure files are where real credentials actually get
// committed, and several of them would otherwise be swallowed by a pattern
// above. DATA_FIXTURE_GLOBS still wins over this list: a file under
// `fixtures/` is test data whatever its name.
//
// The `.env` entries are deliberately narrow. A blanket `**/.env.*` would
// also match `.env.example` and `.env.sample`, whose entire purpose is to
// hold fake values — and because must-scan wins, that would override the
// skip list and defeat it. So real deployment env files are listed by name
// instead of by wildcard.
export const MUST_SCAN_GLOBS = [
  '**/.env',
  '**/.env.local',
  '**/.env.development',
  '**/.env.staging',
  '**/.env.production',
  '**/.env.test',
  '**/docker-compose*.yml',
  '**/docker-compose*.yaml',
  '**/Dockerfile*',
  '**/*.tf',
  '**/*.tfvars',
  '**/*.properties',
  '**/*.ini',
  '**/*.cfg',
  '**/*.toml',
];

// A line longer than this is skipped before reaching any rule's regex —
// not meaningful diff content, and exactly the input shape that triggers
// catastrophic regex backtracking. See rule-runner.ts.
export const MAX_LINE_LENGTH = 2000;
