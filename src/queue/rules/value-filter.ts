import { SecretCandidate } from './rule.interface';

// Decides whether a credential-shaped match is actually a credential.
//
// The division of labour with the rules themselves is deliberate: rule
// regexes are kept loose so they catch real-world formats (unquoted .env,
// YAML, Dockerfile ARG), and everything that makes a match *not* a secret
// is rejected here instead. Adding an exclusion is adding an entry to a
// list in this file — never loosening or tightening a regex, which is how
// detection rules rot.
//
// Returns a short machine-readable reason (logged at debug as
// `secret.filtered`) or null when the candidate survives.

// 1. The value is a reference to a secret, not the secret.
const ENV_REFERENCE_PATTERNS = [
  /^\$\{?[A-Z0-9_]+\}?$/i,
  /^\{\{.*\}\}$/,
  /^<[^>]+>$/,
  /^%[A-Z0-9_]+%$/i,
];

const ENV_REFERENCE_LINE_MARKERS = [
  'process.env',
  'os.environ',
  'os.getenv',
  'getenv(',
  'system.getenv',
  'env[',
  'env.fetch',
  'import.meta.env',
  'deno.env',
  'secrets.',
  'vault:',
  'ssm:',
  'arn:aws:secretsmanager',
  'config(',
  'settings.',
  // CloudFormation `!Ref X`, 1Password `op://vault/item`, GitHub Actions
  // `${{ secrets.X }}` (also caught by 'secrets.').
  '!ref',
  'op://',
  '${{',
];

// 2. The value is a stand-in a human is expected to replace.
const PLACEHOLDER_SUBSTRINGS = [
  'changeme',
  'change_me',
  'example',
  'sample',
  'placeholder',
  'your_',
  'your-',
  'yourkey',
  'dummy',
  'fake',
  'mock',
  'todo',
  'fixme',
  'redacted',
  'removed',
  'masked',
  'my_',
  'xxx',
  '****',
  'insert_',
  'replace_',
  'not_set',
  'undefined',
];

// Whole-value equality only — 'test' and 'none' appear inside plenty of
// real credentials, so substring matching them would suppress genuine hits.
const PLACEHOLDER_EXACT = [
  'test',
  'null',
  'none',
  'undefined',
  'changeme',
  'tbd',
  'secret',
  'password',
  'pass',
  'token',
];

// A generic word as the *first segment* — `secret_value`, `token-here`,
// `test.key` — is someone naming the slot, not filling it. Only with a
// separator after it: `secretpass` or `tokenXk29…` could be anything.
const PLACEHOLDER_PREFIX_PATTERN =
  /^(?:test|secret|password|token)(?:[_.-]|$)/i;

// 4. The value has a structure that rules out it being a credential.
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Pre-release and build metadata are separate optional groups, in that
// order — `1.2.3-beta.11+build.9` carries both, and a single `[-+]…` group
// only matches one of them.
const SEMVER_PATTERN =
  /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?/;
const IPV4_PATTERN = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/i;
const STRIPE_PUBLISHABLE_PATTERN = /^pk_(test|live)_/;
const SUBRESOURCE_INTEGRITY_PATTERN = /^sha(256|384|512)[-:]/i;
// A URL is only noise while it carries no inline credentials — a
// `user:pass@host` URL is exactly what secret.db_url_with_password exists
// for, so it must not be filtered away here.
const URL_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;
const URL_WITH_CREDENTIALS_PATTERN =
  /^[a-z][a-z0-9+.-]*:\/\/[^/@\s]+:[^/@\s]+@/i;

// A key name that itself says "credential" keeps a value that would
// otherwise be filtered as structural noise: a 40-hex value assigned to
// API_SECRET is far more likely a real key than a git sha.
const CREDENTIAL_KEY_PATTERN = /SECRET|TOKEN|PASSWORD|PASSWD|PWD|KEY/i;

const SEQUENTIAL_RUNS = [
  'abcdefghijklmnopqrstuvwxyz',
  '0123456789',
  'qwertyuiop',
];

const COMMENT_PREFIXES = ['#', '//', '/*', '*', '--', '<!--'];

function isEnvReference(candidate: SecretCandidate): boolean {
  if (ENV_REFERENCE_PATTERNS.some((p) => p.test(candidate.value))) {
    return true;
  }
  const line = candidate.raw.toLowerCase();
  return ENV_REFERENCE_LINE_MARKERS.some((marker) => line.includes(marker));
}

function isPlaceholder(value: string): boolean {
  const lower = value.toLowerCase();
  if (PLACEHOLDER_EXACT.includes(lower)) {
    return true;
  }
  if (PLACEHOLDER_PREFIX_PATTERN.test(value)) {
    return true;
  }
  return PLACEHOLDER_SUBSTRINGS.some((needle) => lower.includes(needle));
}

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Placeholder words, plus a value that just repeats its own key name
// (`password = "password"`, `api_key: api-key`). Exported for rules that
// validate a value without going through filterValue.
export function isPlaceholderValue(value: string, key?: string): boolean {
  if (isPlaceholder(value)) {
    return true;
  }
  return key !== undefined && normalizeName(key) === normalizeName(value);
}

// A value made of one repeated character, or a long run straight off the
// keyboard, is someone filling a field rather than a generated credential.
function isPatterned(value: string): boolean {
  const counts = new Map<string, number>();
  for (const char of value) {
    counts.set(char, (counts.get(char) ?? 0) + 1);
  }
  const mostCommon = Math.max(...counts.values());
  if (mostCommon / value.length >= 0.6) {
    return true;
  }

  if (/^\d+$/.test(value)) {
    return true;
  }

  // A keyboard run only means "someone filled this field" when it accounts
  // for most of the value, so what matters is the longest run present, not
  // whether any 8-character run appears at all. `abcdEFGH1234ijkl5678` is a
  // plausible generated credential that happens to contain `abcdefgh`;
  // rejecting it on presence alone silently drops real findings, while
  // `abcdefghijklmnop` is almost entirely one run and is noise.
  const lower = value.toLowerCase();
  const longestRun = longestSequentialRun(lower);
  return longestRun >= 8 && longestRun / value.length >= 0.6;
}

// Length of the longest substring of `value` that appears verbatim in one
// of the keyboard/alphabet runs.
function longestSequentialRun(value: string): number {
  let longest = 0;
  for (const run of SEQUENTIAL_RUNS) {
    for (let start = 0; start < value.length; start += 1) {
      for (let end = value.length; end > start + longest; end -= 1) {
        if (run.includes(value.slice(start, end))) {
          longest = end - start;
          break;
        }
      }
    }
  }
  return longest;
}

// 5. Value-shape checks (v1.5.0 delta 2 §3). Exported so rules that check a
// value themselves (hardcoded_password, db_url_with_password) apply the same
// definitions instead of keeping their own copies.

// `${...}` means the real value only exists at runtime, so whatever is in
// the source is a template, not a credential. Caught here rather than by
// entropy, because interpolation syntax is itself varied enough to push a
// short template over any sensible threshold:
// `diff-line:${filePath}:${line}` scores 3.75, higher than plenty of real
// secrets.
//
// `{name}` is the same idea for str.format, route and key templates —
// `scan:{repoId}:{prNumber}:{headSha}`. Generated credentials (base64, hex,
// random alphanumerics) never contain a brace-wrapped identifier. Likewise
// printf `%s`, `__VAULT_PASSWORD__` build-time tokens, `<your-key>` and an
// elided `...` / `…`.
const INTERPOLATION_PATTERN =
  /\$\{|#\{|%\(|%s|<%=|\{[A-Za-z_]\w*\}|__[A-Za-z0-9][A-Za-z0-9_]*__|<[^<>]*>|\.\.\.|…/;

export function isTemplateValue(value: string): boolean {
  return INTERPOLATION_PATTERN.test(value);
}

// Characters that surround a value in code but never appear in a generated
// credential: whitespace, quotes, brackets, `,` and `;`. This is what
// rejects `'(,=:[!&|?{};+-*%<>~^'`, prose from a comment, inline JSON and a
// call like `re.compile(r` (assignment_literal's capture stops at the first
// quote). `!@#$%^&*~` are NOT here — they are exactly what real passwords
// contain.
const STRUCTURAL_PUNCTUATION_PATTERN = /[\s"'`()[\]{}<>,;]/;

export function hasStructuralPunctuation(value: string): boolean {
  return STRUCTURAL_PUNCTUATION_PATTERN.test(value);
}

// Names of a state or a constant — `no_secret_configured`, `read-only`,
// `TOKEN_EXPIRED` — rather than a secret. snake/kebab must be letters only:
// `whsec_a1b2c3…` is a real Stripe webhook secret with the same shape plus
// digits.
const SNAKE_OR_KEBAB_WORDS_PATTERN = /^[a-z]+(?:[_-][a-z]+)+$/;
const SCREAMING_SNAKE_PATTERN = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;

function digitRatio(value: string): number {
  return (value.match(/\d/g) ?? []).length / value.length;
}

export function isStateIdentifier(value: string): boolean {
  if (SNAKE_OR_KEBAB_WORDS_PATTERN.test(value)) {
    return true;
  }
  return SCREAMING_SNAKE_PATTERN.test(value) && digitRatio(value) < 0.2;
}

// Letters-only and short: `NotConfigured`, `unknownRepo`. Generated tokens
// almost always carry digits. Only for token-style values — a human
// password like `letmein` is letters-only too, so hardcoded_password does
// not use this.
const LETTERS_ONLY_PATTERN = /^[A-Za-z]+$/;
const MAX_LETTERS_ONLY_IDENTIFIER = 24;

// Shannon entropy floor for token-style values of 16+ characters. The
// delta-2 prompt asked for 3.0, but that discards
// `akjsbdkajsbkjabskdjbaskdjbskjdf` (2.69), the very secret the rule was
// built to catch; 2.5 still rejects fillers like `aaaa…`. Sequential values
// (`abcdefghijklmnop` = 4.0, `1234567890123456` = 3.25) are high-entropy and
// are rejected by isPatterned instead.
const MIN_ENTROPY = 2.5;
const ENTROPY_MIN_LENGTH = 16;

function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) {
    counts.set(char, (counts.get(char) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function hasLowEntropy(value: string): boolean {
  return (
    value.length >= ENTROPY_MIN_LENGTH && shannonEntropy(value) < MIN_ENTROPY
  );
}

// `cond ? 'no_secret_configured' : 'unknown_repo'` — assignment_literal reads
// the true branch as a key and the `:` as an assignment. Only a `:` after a
// `?` counts: `?api_key=…` in a URL query is a real credential and keeps its
// `=`.
function isTernaryBranch(candidate: SecretCandidate): boolean {
  const { key, raw } = candidate;
  if (!key) {
    return false;
  }
  const at = raw.indexOf(key);
  if (at < 0) {
    return false;
  }
  const before = raw
    .slice(0, at)
    .replace(/["'`]$/, '')
    .trimEnd();
  const after = raw
    .slice(at + key.length)
    .replace(/^["'`]/, '')
    .trimStart();
  return (
    before.endsWith('?') && after.startsWith(':') && !after.startsWith(':=')
  );
}

// Identifier-shaped values: CamelCase, snake_case, kebab-case or
// dot.separated words. Icon names, i18n keys, class names and enum values
// all look like this, and all of them beat the entropy threshold —
// `TbAdjustmentsHorizontal` scores 4.06 while the secret that prompted this
// whole change, `akjsbdkajsbkjabskdjbaskdjbskjdf`, scores 2.69. Entropy
// cannot separate the two in either direction; word structure can.
//
// Requires at least two segments of 3+ letters, so a genuinely random value
// that happens to contain one capital run is unaffected.
const WORD_SEGMENTED_PATTERN =
  /^[A-Za-z][A-Za-z0-9]*(?:(?:[A-Z][a-z]{2,})|(?:[_.-][A-Za-z]{3,})){2,}[A-Za-z0-9]*$/;

function isWordSegmented(value: string): boolean {
  if (!WORD_SEGMENTED_PATTERN.test(value)) {
    return false;
  }
  // Digits are rare in identifiers and common in generated credentials, so
  // a value that is meaningfully numeric is not treated as word-shaped.
  const digits = (value.match(/\d/g) ?? []).length;
  return digits / value.length < 0.2;
}

function isStructurallyNotSecret(candidate: SecretCandidate): boolean {
  const { value, key } = candidate;

  if (isTemplateValue(value)) return true;
  if (hasStructuralPunctuation(value)) return true;
  if (isTernaryBranch(candidate)) return true;
  if (isStateIdentifier(value)) return true;
  if (isWordSegmented(value)) return true;
  if (UUID_PATTERN.test(value)) return true;
  if (SEMVER_PATTERN.test(value)) return true;
  if (ISO_DATE_PATTERN.test(value)) return true;
  if (IPV4_PATTERN.test(value)) return true;
  if (STRIPE_PUBLISHABLE_PATTERN.test(value)) return true;
  if (SUBRESOURCE_INTEGRITY_PATTERN.test(value)) return true;

  if (URL_PATTERN.test(value) && !URL_WITH_CREDENTIALS_PATTERN.test(value)) {
    return true;
  }

  // Exactly 40 hex characters is a git sha far more often than a secret —
  // unless the key name says otherwise.
  if (GIT_SHA_PATTERN.test(value) && !CREDENTIAL_KEY_PATTERN.test(key ?? '')) {
    return true;
  }

  return false;
}

// A commented-out line holding a placeholder is documentation, so it is not
// a finding at all. A commented-out line holding a real-looking credential
// is kept here: the processor stores it suppressed as COMMENT in source code
// — still visible, since git history does not care about the `#` — and
// active in config/infra files (src/queue/suppression.ts).
function isInertComment(candidate: SecretCandidate): boolean {
  const trimmed = candidate.raw.trimStart();
  const isComment = COMMENT_PREFIXES.some((prefix) =>
    trimmed.startsWith(prefix),
  );
  return isComment && isPlaceholder(candidate.value);
}

export type FilterReason =
  | 'env_reference'
  | 'placeholder'
  | 'patterned'
  | 'not_secret_shaped'
  | 'inert_comment';

// Order matters, and structural checks come first on purpose. A Stripe
// publishable key or an integrity hash would often also trip `isPatterned`
// or `isPlaceholder` by coincidence — filtering it for the wrong reason
// still filters it, but the reason is what gets logged and tuned against,
// and a value that happens to be more random would slip through a check
// that was only ever matching it by accident.
export function filterValue(candidate: SecretCandidate): FilterReason | null {
  if (isEnvReference(candidate)) return 'env_reference';
  if (isStructurallyNotSecret(candidate)) return 'not_secret_shaped';
  if (isPlaceholderValue(candidate.value, candidate.key)) return 'placeholder';
  if (isPatterned(candidate.value) || hasLowEntropy(candidate.value)) {
    return 'patterned';
  }
  // After `patterned` so `aaaa…` / `abcdefgh…` keep their more specific
  // reason; what is left here is a short all-letters name.
  if (
    LETTERS_ONLY_PATTERN.test(candidate.value) &&
    candidate.value.length < MAX_LETTERS_ONLY_IDENTIFIER
  ) {
    return 'not_secret_shaped';
  }
  if (isInertComment(candidate)) return 'inert_comment';
  return null;
}
