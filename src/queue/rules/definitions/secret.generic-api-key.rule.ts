import { Rule, RuleFinding } from '../rule.interface';

// Matches an assignment-shaped line: api_key/apikey/secret_key/secret
// identifier = a long-ish quoted literal. Deliberately excludes obvious
// non-secrets (env var references, template placeholders, common
// example/placeholder text) so the rule doesn't fire on the exact patterns
// people use to say "put a real value here."
//
// Bare `secret` is included, not just `secret_key`: JWT_SECRET,
// CLIENT_SECRET, WEBHOOK_SECRET and GITHUB_SECRET are all ordinary names
// for a real credential, and requiring the `_key` suffix let every one of
// them through. The trailing (?![a-z]) stops it from matching identifiers
// that merely start with the word — secretPath, secretName, secretsManager
// — which hold a location or label, not the credential itself.
const ASSIGNMENT_PATTERN =
  /(?:api[_-]?key|apikey|secret[_-]?key|secret(?![a-z]))\s*[:=]\s*['"]([A-Za-z0-9_\-/+=]{16,})['"]/i;

const PLACEHOLDER_PATTERN =
  /^(changeme|example|xxx+|your[_-]?(key|api[_-]?key)|<.*>|\$\{.*\}|\.\.\.)$/i;

export const secretGenericApiKeyRule: Rule = {
  id: 'secret.generic_api_key',
  severity: 'critical',
  title: 'Hardcoded API key',
  message:
    'This assigns what looks like a real API key as a string literal. Move it to an environment variable or secrets manager and rotate the key — a key committed to git must be treated as compromised.',
  languages: '*',
  test(ctx) {
    const findings: RuleFinding[] = [];
    for (const line of ctx.addedLines) {
      const match = ASSIGNMENT_PATTERN.exec(line.text);
      if (!match) {
        continue;
      }
      const value = match[1];
      if (PLACEHOLDER_PATTERN.test(value)) {
        continue;
      }
      findings.push({
        lineStart: line.newLine,
        lineEnd: line.newLine,
        snippet: value.slice(0, 4) + '****',
      });
    }
    return findings;
  },
};
