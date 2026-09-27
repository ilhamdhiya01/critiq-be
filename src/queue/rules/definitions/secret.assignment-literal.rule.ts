import { Rule, RuleFinding } from '../rule.interface';

// Matches `<credential-ish key> = <value>` in whatever syntax the file
// happens to use: .env, shell export, Dockerfile ENV/ARG, YAML, JSON, JS,
// Go's :=, PHP/Ruby's =>, INI/properties, and -D java args.
//
// Two deliberate looseness choices, both of which the previous rule got
// wrong and which let `GITHUB_SECRET=akjsbdk...` through unflagged:
//
//  1. Quotes are optional. The old pattern required `['"]…['"]`, so every
//     unquoted format — which is most config formats — silently missed.
//  2. The key is matched as a substring, not a whole word. `SECRET` alone
//     is not a key name anyone uses; `GITHUB_SECRET`, `JWT_SECRET` and
//     `APP_CLIENT_SECRET` are.
//
// False positives are not handled here at all — that is ValueFilter's job
// (see value-filter.ts). Keeping the regex permissive and the exclusions in
// a list is what stops this rule from rotting into a pile of special cases.
const KEY_WORDS = [
  'SECRET',
  'TOKEN',
  'PASSWORD',
  'PASSWD',
  'PWD',
  'API[_-]?KEY',
  'APIKEY',
  'ACCESS[_-]?KEY',
  'PRIVATE[_-]?KEY',
  'CLIENT[_-]?SECRET',
  'CREDENTIAL',
  'SIGNING[_-]?KEY',
  'WEBHOOK[_-]?SECRET',
  'JWT[_-]?SECRET',
  'ENCRYPTION[_-]?KEY',
  'AUTH[_-]?KEY',
  'BEARER',
  'DSN',
].join('|');

// Two things keep this safe against catastrophic backtracking, both
// verified by the safe-regex2 assertion in rules.spec.ts:
//
//  - The key's prefix/suffix are bounded (`{0,40}`) rather than `*?`.
//  - There is no `(?:export\s+|ENV\s+|const\s+|…)?` declaration group. An
//    optional alternation whose every branch ends in `\s+` is ambiguous
//    with the `[\s…]` that precedes it, and safe-regex2 rejects the whole
//    pattern for it. It is also unnecessary: the leading `(?:^|[\s,{(\[])`
//    already consumes the space after `export`/`ENV`/`const`, so all of
//    those forms still match.
const ASSIGNMENT_PATTERN = new RegExp(
  [
    String.raw`(?:^|[\s,{(\[])`,
    String.raw`["']?`,
    String.raw`(?<key>[A-Za-z0-9_.\-]{0,40}(?:${KEY_WORDS})[A-Za-z0-9_.\-]{0,40})`,
    String.raw`["']?`,
    String.raw`\s*(?:=>|:=|[:=])\s*`,
    // The closing quote is not matched here. JS regex can't reliably
    // backreference an optional group, so the value is captured up to the
    // first delimiter and any trailing quote is trimmed below.
    String.raw`["'\`]?(?<value>[^\s"'\`#;,)}\]]{12,})`,
  ].join(''),
  'i',
);

const TRAILING_QUOTES = /["'`]+$/;

export const secretAssignmentLiteralRule: Rule = {
  id: 'secret.assignment_literal',
  severity: 'critical',
  title: 'Hardcoded credential',
  message:
    'This assigns what looks like a real credential as a literal value. Move it to an environment variable or secrets manager and rotate it — a credential committed to git must be treated as compromised.',
  languages: '*',
  patterns: [ASSIGNMENT_PATTERN],
  test(ctx) {
    const findings: RuleFinding[] = [];
    for (const line of ctx.addedLines) {
      const match = ASSIGNMENT_PATTERN.exec(line.text);
      const key = match?.groups?.key;
      const rawValue = match?.groups?.value;
      if (!key || !rawValue) {
        continue;
      }

      const value = rawValue.replace(TRAILING_QUOTES, '');
      if (value.length < 12) {
        continue;
      }

      findings.push({
        lineStart: line.newLine,
        lineEnd: line.newLine,
        // Key kept in full (it names the credential, it is not the
        // credential); value cut to four characters so a reviewer can tell
        // two findings apart without the secret leaving the worker.
        snippet: `${key}=${value.slice(0, 4)}****`.slice(0, 120),
        candidate: {
          ruleId: 'secret.assignment_literal',
          line: line.newLine,
          key,
          value,
          raw: line.text,
        },
      });
    }
    return findings;
  },
};
