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
  'xxxx',
  '****',
  'insert_',
  'replace_',
  'not_set',
  'undefined',
];

// Whole-value equality only — 'test' and 'none' appear inside plenty of
// real credentials, so substring matching them would suppress genuine hits.
const PLACEHOLDER_EXACT = ['test', 'null', 'none', 'undefined', 'changeme'];

// 4. The value has a structure that rules out it being a credential.
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SEMVER_PATTERN = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
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
  return PLACEHOLDER_SUBSTRINGS.some((needle) => lower.includes(needle));
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

function isStructurallyNotSecret(candidate: SecretCandidate): boolean {
  const { value, key } = candidate;

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

// A commented-out line holding a placeholder is documentation. A commented
// -out line holding a real-looking credential is still a leak — git history
// does not care that the line starts with `#` — so only the placeholder
// case is filtered here.
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
  if (isPlaceholder(candidate.value)) return 'placeholder';
  if (isPatterned(candidate.value)) return 'patterned';
  if (isInertComment(candidate)) return 'inert_comment';
  return null;
}
