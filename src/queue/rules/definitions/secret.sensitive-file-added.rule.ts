import { minimatch } from 'minimatch';
import { Rule } from '../rule.interface';

// Files whose very presence in a repo is the finding — a private key or a
// credentials file has no "safe" contents. Matching on the path means this
// still fires when the file arrives with no patch at all, which is the
// normal case for a real 2048-bit key: providers omit the patch for binary
// blobs and oversized diffs.
const SENSITIVE_PATH_GLOBS = [
  '**/*.pem',
  '**/*.key',
  '**/*.p12',
  '**/*.pfx',
  '**/*.jks',
  '**/*.keystore',
  '**/*.asc',
  '**/id_rsa',
  '**/id_dsa',
  '**/id_ecdsa',
  '**/id_ed25519',
  '**/*.ppk',
  '**/service-account*.json',
  '**/*-credentials.json',
  '**/credentials.json',
  '**/.npmrc',
  '**/.pypirc',
  '**/.netrc',
  '**/.htpasswd',
  '**/*.kdbx',
  '**/secrets.yml',
  '**/secrets.yaml',
  '**/secrets.json',
];

// A public key is meant to be shared — `id_rsa.pub` next to `id_rsa` is
// normal and not a leak.
const PUBLIC_KEY_GLOB = '**/*.pub';

// Sample keys used to exercise TLS code or sign test fixtures are expected
// to live in the repo. Matched as a path substring rather than through
// SECRET_SKIP_GLOBS because those globs are extension- and directory-shaped,
// while these names show up anywhere in a path (`certs/test-key.pem`).
const EXEMPT_PATH_WORDS = ['test', 'fixture', 'example', 'sample', 'mock'];

const MATCH_OPTIONS = { dot: true, nocase: true } as const;

export const secretSensitiveFileAddedRule: Rule = {
  id: 'secret.sensitive_file_added',
  severity: 'critical',
  title: 'Credential file added',
  message:
    'A credential file was added to the repository. Remove it from git, add it to .gitignore, and treat its contents as leaked — anything committed to git history must be rotated, even if the commit is reverted.',
  languages: '*',
  kind: 'file',
  test(ctx) {
    // Only an added or renamed file. A `modified` credential file was
    // already in the repo before this PR: still a problem, but not one this
    // PR introduced, and flagging it would fire on every later commit that
    // touches the file.
    if (ctx.status !== 'added' && ctx.status !== 'renamed') {
      return [];
    }

    const path = ctx.filePath;
    if (minimatch(path, PUBLIC_KEY_GLOB, MATCH_OPTIONS)) {
      return [];
    }
    const lowerPath = path.toLowerCase();
    if (EXEMPT_PATH_WORDS.some((word) => lowerPath.includes(word))) {
      return [];
    }
    if (!SENSITIVE_PATH_GLOBS.some((g) => minimatch(path, g, MATCH_OPTIONS))) {
      return [];
    }

    // Line 1 and no snippet: the finding is about the file existing, and
    // there is no line to point at — often no readable content at all.
    return [{ lineStart: 1, lineEnd: 1, snippet: null }];
  },
};
