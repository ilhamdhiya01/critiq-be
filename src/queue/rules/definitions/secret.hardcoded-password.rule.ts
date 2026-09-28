import { Rule, RuleFinding } from '../rule.interface';
import {
  hasStructuralPunctuation,
  isPlaceholderValue,
  isStateIdentifier,
  isTemplateValue,
} from '../value-filter';

const PASSWORD_ASSIGNMENT_PATTERN =
  /(?:password|passwd|pwd)\s*[:=]\s*['"]([^'"]{4,})['"]/i;

const PLACEHOLDER_PATTERN =
  /^(changeme|example|xxx+|<.*>|\$\{.*\}|your[_-]?password)$/i;

// Test/fixture/example paths are not excluded here: the processor stores a
// hit there as suppressed (src/queue/suppression.ts), for every rule alike.

// Not a password (v1.5.0 delta 2 §3), using ValueFilter's definitions so
// they cannot drift apart: a template (`{{ vault_password }}`), a
// placeholder or the key's own name, a state name (`not_configured`), or
// UI prose with spaces (`'Enter your password'`). The letters-only and
// entropy checks ValueFilter applies to tokens are deliberately left out —
// human passwords like `letmein` are short and letters-only, and still real.
function isNotAPassword(value: string): boolean {
  return (
    PLACEHOLDER_PATTERN.test(value) ||
    isTemplateValue(value) ||
    isPlaceholderValue(value) ||
    isStateIdentifier(value) ||
    hasStructuralPunctuation(value)
  );
}

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
      if (isNotAPassword(value)) {
        continue;
      }
      findings.push({
        lineStart: line.newLine,
        lineEnd: line.newLine,
        matchStart: match.index,
        matchLength: match[0].length,
        snippet: null,
      });
    }
    return findings;
  },
};
