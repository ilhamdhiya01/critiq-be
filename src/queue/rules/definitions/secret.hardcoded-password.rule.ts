import { Rule, RuleFinding } from '../rule.interface';

const PASSWORD_ASSIGNMENT_PATTERN =
  /(?:password|passwd|pwd)\s*[:=]\s*['"]([^'"]{4,})['"]/i;

const PLACEHOLDER_PATTERN =
  /^(changeme|example|xxx+|<.*>|\$\{.*\}|your[_-]?password)$/i;

// Test/fixture/example paths used to be excluded by a regex here. That is
// now SECRET_SKIP_GLOBS, applied to the whole `secret.*` family in
// rule-runner.ts — one tested list instead of a copy per rule.

export const secretHardcodedPasswordRule: Rule = {
  id: 'secret.hardcoded_password',
  severity: 'critical',
  title: 'Hardcoded password',
  message:
    'This assigns a literal password value in code. Move it to an environment variable or secrets manager, and rotate the credential if it is real — a password committed to git must be treated as compromised.',
  languages: '*',
  test(ctx) {
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
