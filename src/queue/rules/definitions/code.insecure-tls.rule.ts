import { Rule, RuleFinding } from '../rule.interface';

const PATTERNS = [
  /rejectUnauthorized\s*:\s*false/,
  /verify\s*=\s*False/,
  /InsecureSkipVerify\s*:\s*true/,
  /NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0['"]?/,
];

export const codeInsecureTlsRule: Rule = {
  id: 'code.insecure_tls',
  severity: 'critical',
  title: 'TLS certificate verification disabled',
  message:
    'Disabling TLS certificate verification (rejectUnauthorized: false, verify=False, InsecureSkipVerify: true, or NODE_TLS_REJECT_UNAUTHORIZED=0) makes the connection vulnerable to man-in-the-middle attacks. Fix the underlying certificate issue instead of disabling verification, even in development code that risks being copy-pasted into production.',
  languages: '*',
  test(ctx) {
    const findings: RuleFinding[] = [];
    for (const line of ctx.addedLines) {
      if (PATTERNS.some((pattern) => pattern.test(line.text))) {
        findings.push({
          lineStart: line.newLine,
          lineEnd: line.newLine,
          snippet: line.text.trim().slice(0, 200),
        });
      }
    }
    return findings;
  },
};
