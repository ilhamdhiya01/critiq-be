import { Rule, RuleFinding } from '../rule.interface';

// Matches an assignment-shaped line: api_key/apikey/secret_key/token/
// password-ish identifier = a long-ish quoted literal. Deliberately
// excludes obvious non-secrets (env var references, template placeholders,
// common example/placeholder text) so the rule doesn't fire on the exact
// patterns people use to say "put a real value here."
const ASSIGNMENT_PATTERN =
  /(?:api[_-]?key|apikey|secret[_-]?key)\s*[:=]\s*['"]([A-Za-z0-9_\-/+=]{16,})['"]/i;

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
