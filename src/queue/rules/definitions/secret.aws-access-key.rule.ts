import { Rule, RuleFinding } from '../rule.interface';

const AWS_ACCESS_KEY_PATTERN = /AKIA[0-9A-Z]{16}/;

export const secretAwsAccessKeyRule: Rule = {
  id: 'secret.aws_access_key',
  severity: 'critical',
  title: 'AWS access key committed',
  message:
    'This looks like an AWS access key ID. Move it to an environment variable or secrets manager and rotate the key immediately — a key that has ever been committed to git must be treated as compromised.',
  languages: '*',
  // The AKIA prefix is proof enough on its own, and ValueFilter would
  // actively hurt here: AWS's own documented example key is
  // AKIAIOSFODNN7EXAMPLE, which the placeholder check would discard for
  // containing the word EXAMPLE. A key in that shape is worth reporting
  // whatever it spells.
  skipValueFilter: true,
  patterns: [AWS_ACCESS_KEY_PATTERN],
  test(ctx) {
    const findings: RuleFinding[] = [];
    for (const line of ctx.addedLines) {
      const match = AWS_ACCESS_KEY_PATTERN.exec(line.text);
      if (match) {
        findings.push({
          lineStart: line.newLine,
          lineEnd: line.newLine,
          snippet: match[0].slice(0, 4) + '****',
        });
      }
    }
    return findings;
  },
};
