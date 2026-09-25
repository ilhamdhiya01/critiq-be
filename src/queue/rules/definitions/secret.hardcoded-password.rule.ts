import { Rule, RuleFinding } from '../rule.interface';

const PASSWORD_ASSIGNMENT_PATTERN =
  /(?:password|passwd|pwd)\s*[:=]\s*['"]([^'"]{4,})['"]/i;

const PLACEHOLDER_PATTERN =
  /^(changeme|example|xxx+|<.*>|\$\{.*\}|your[_-]?password)$/i;

// Fixture/test files are exactly where a *real* password would be least
// harmful (mock data, not a live credential) and most likely to trip a
// false positive (fixture strings intentionally look password-shaped) —
// excluded by path rather than content.
const EXCLUDED_PATH_PATTERN =
  /(\.test\.|\.spec\.|\/fixtures\/|\.example($|\.)|\.md$)/i;

export const secretHardcodedPasswordRule: Rule = {
  id: 'secret.hardcoded_password',
  severity: 'critical',
  title: 'Hardcoded password',
  message:
    'This assigns a literal password value in code. Move it to an environment variable or secrets manager, and rotate the credential if it is real — a password committed to git must be treated as compromised.',
  languages: '*',
  test(ctx) {
    if (EXCLUDED_PATH_PATTERN.test(ctx.filePath)) {
      return [];
    }

    const findings: RuleFinding[] = [];
    for (const line of ctx.addedLines) {
      const match = PASSWORD_ASSIGNMENT_PATTERN.exec(line.text);
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
        snippet: null,
      });
    }
    return findings;
  },
};
