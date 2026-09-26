import { Rule, RuleFinding } from '../rule.interface';

const JWT_PATTERN =
  /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/;

// Test/fixture paths used to be excluded by a regex here. That is now
// SECRET_SKIP_GLOBS, applied to the whole `secret.*` family in
// rule-runner.ts — one tested list instead of a copy per rule.

export const secretJwtLiteralRule: Rule = {
  id: 'secret.jwt_literal',
  severity: 'critical',
  title: 'JWT literal committed',
  message:
    'This is a literal JWT (JSON Web Token). If it is a real session/auth token it must be treated as compromised — revoke the underlying session/key and move tokens to runtime-only storage, never source code.',
  languages: '*',
  test(ctx) {
    const findings: RuleFinding[] = [];
    for (const line of ctx.addedLines) {
      const match = JWT_PATTERN.exec(line.text);
      if (match) {
        findings.push({
          lineStart: line.newLine,
          lineEnd: line.newLine,
          snippet: match[0].slice(0, 8) + '****',
        });
      }
    }
    return findings;
  },
};
