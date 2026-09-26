import { Rule, RuleFinding } from '../rule.interface';

// `postgresql` as well as `postgres`: that is the spelling PostgreSQL's own
// docs and Prisma use, so it is what a real DATABASE_URL almost always
// says — this repo's included. Matching only `postgres` missed it.
const DB_URL_PATTERN =
  /(postgresql|postgres|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^:\s]+:([^@\s]{4,})@/;

// Masked values (`****`) are placeholders too — e.g. documentation, or
// Critiq's own redacted snippet `postgres://****:****@` appearing in a test.
const PLACEHOLDER_PATTERN = /^(<.*>|\$\{.*\}|password|changeme|\*+)$/i;

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
