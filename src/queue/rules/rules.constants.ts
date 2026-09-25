export const RULESET_VERSION = '2026.09';

// Paths matching any of these are skipped entirely before any rule runs:
// generated/vendored/binary content a rule could never meaningfully flag.
// Three shapes are supported — `*.ext` (basename suffix), `dir/**` (a path
// segment anywhere) and a bare exact basename — matched by path-filter.ts,
// deliberately not a general glob engine (no dependency for a fixed list).
export const IGNORE_GLOBS = [
  '*.lock',
  // npm/pnpm lockfiles don't end in .lock, but are just as generated and
  // routinely hundreds of KB — without these a dependency bump alone could
  // push a normal PR over SCAN_MAX_DIFF_BYTES.
  'package-lock.json',
  'pnpm-lock.yaml',
  '*.min.js',
  '*.map',
  'dist/**',
  'node_modules/**',
  'vendor/**',
  '*.snap',
  '*.svg',
  '*.png',
  '*.jpg',
  '*.gif',
  '*.ico',
  '*.woff',
  '*.woff2',
];

// A line longer than this is skipped before reaching any rule's regex —
// not meaningful diff content, and exactly the input shape that triggers
// catastrophic regex backtracking. See rule-runner.ts.
export const MAX_LINE_LENGTH = 2000;
