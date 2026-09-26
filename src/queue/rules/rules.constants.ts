// Bumped whenever the rules change what they would find on the same diff.
// ScanQueueService compares a PR's last scan against this and re-scans when
// they differ, so a bump makes every open PR's next webhook produce fresh
// results instead of serving a verdict the old rules reached.
export const RULESET_VERSION = '2026.09.2';

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

// Skipped for `secret.*` rules only (path-filter.ts's isSecretSkippedPath),
// never for code./config. rules. These are the places a credential-shaped
// string is expected and meaningless: documentation, example env files, and
// test fixtures whose whole job is to contain fake secrets.
//
// This list replaces the per-rule EXCLUDED_PATH_PATTERN regexes that
// secret.hardcoded_password and secret.jwt_literal each used to hand-roll.
export const SECRET_SKIP_GLOBS = [
  '**/*.example',
  '**/*.sample',
  '**/*.template',
  '**/*.dist',
  '**/*.example.*',
  '**/*.sample.*',
  '**/*.md',
  '**/*.mdx',
  '**/*.rst',
  // `*.txt` is deliberately NOT here, though the spec listed it with the
  // other prose formats: a private key pasted into `key.txt` or
  // `credentials.txt` is a real and common way to leak one, and skipping
  // the extension outright would make secret.private_key_block unable to
  // see its most likely input.
  '**/*.test.*',
  '**/*.spec.*',
  '**/__tests__/**',
  '**/__mocks__/**',
  '**/test/**',
  '**/tests/**',
  '**/fixtures/**',
  '**/testdata/**',
  '**/e2e/**',
];

// Overrides SECRET_SKIP_GLOBS — a file matching both is still scanned for
// secrets. Config and infrastructure files are where real credentials
// actually get committed, and several of them would otherwise be swallowed
// by a skip pattern above.
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
