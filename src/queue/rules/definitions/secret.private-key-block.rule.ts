import { Rule, RuleFinding } from '../rule.interface';

const PRIVATE_KEY_HEADER_PATTERN =
  /-----BEGIN (RSA|EC|OPENSSH|DSA|PGP) PRIVATE KEY-----/;

export const secretPrivateKeyBlockRule: Rule = {
  id: 'secret.private_key_block',
  severity: 'critical',
  title: 'Private key committed',
  message:
    'This looks like a PEM-encoded private key. Remove it from the repository and rotate the key pair immediately — a private key that has ever been committed to git must be treated as compromised, history rewrite alone is not enough.',
  languages: '*',
  test(ctx) {
    const findings: RuleFinding[] = [];
    for (const line of ctx.addedLines) {
      if (PRIVATE_KEY_HEADER_PATTERN.test(line.text)) {
        findings.push({
          lineStart: line.newLine,
          lineEnd: line.newLine,
          // The header line alone doesn't leak key material, but the
          // convention for every secret.* rule is to never persist matched
          // text — redact uniformly so reviewers don't need to remember
          // which secret rules are "safe" to show a snippet for.
          snippet: null,
        });
      }
    }
    return findings;
  },
};
