import { Rule, RuleFinding } from '../rule.interface';

const DB_URL_PATTERN =
  /(postgres|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^:\s]+:([^@\s]{4,})@/;

const PLACEHOLDER_PATTERN = /^(<.*>|\$\{.*\}|password|changeme)$/i;

export const secretDbUrlWithPasswordRule: Rule = {
  id: 'secret.db_url_with_password',
  severity: 'critical',
  title: 'Database connection string with embedded password',
  message:
    'This connection string embeds a plaintext password. Move it to an environment variable and rotate the credential — a password committed to git must be treated as compromised.',
  languages: '*',
  test(ctx) {
    const findings: RuleFinding[] = [];
    for (const line of ctx.addedLines) {
      const match = DB_URL_PATTERN.exec(line.text);
      if (!match) {
        continue;
      }
      const scheme = match[1];
      const password = match[2];
      if (PLACEHOLDER_PATTERN.test(password)) {
        continue;
      }
      findings.push({
        lineStart: line.newLine,
        lineEnd: line.newLine,
        snippet: `${scheme}://****:****@`,
      });
    }
    return findings;
  },
};
