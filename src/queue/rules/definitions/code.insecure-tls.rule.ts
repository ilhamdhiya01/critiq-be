import { findCodeMatch } from '../line-context';
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
      // Comments and string prose (docs, error messages — including this
      // rule's own `message`) only mention the option; they don't set it.
      // A regex that looks for the option is kept, with its position, so the
      // processor can store it suppressed as REGEX_LITERAL.
      for (const pattern of PATTERNS) {
        const match = findCodeMatch(pattern, line.text, ctx.language);
        if (match) {
          findings.push({
            lineStart: line.newLine,
            lineEnd: line.newLine,
            snippet: line.text.trim().slice(0, 200),
            matchStart: match.start,
            matchLength: match.length,
          });
          break;
        }
      }
    }
    return findings;
  },
};
