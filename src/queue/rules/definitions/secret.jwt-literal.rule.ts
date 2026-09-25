import { Rule, RuleFinding } from '../rule.interface';

const JWT_PATTERN =
  /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/;

// Test/fixture files are the one place a JWT literal is expected and
// harmless — a sample token used to exercise auth middleware in tests,
// never a live credential in normal practice.
const EXCLUDED_PATH_PATTERN = /(\.test\.|\.spec\.|\/fixtures\/)/i;

export const secretJwtLiteralRule: Rule = {
  id: 'secret.jwt_literal',
  severity: 'critical',
  title: 'JWT literal committed',
  message:
    'This is a literal JWT (JSON Web Token). If it is a real session/auth token it must be treated as compromised — revoke the underlying session/key and move tokens to runtime-only storage, never source code.',
  languages: '*',
  test(ctx) {
    if (EXCLUDED_PATH_PATTERN.test(ctx.filePath)) {
      return [];
    }

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
