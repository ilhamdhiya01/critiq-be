import { Rule, RuleFinding } from '../rule.interface';

const GITHUB_TOKEN_PATTERN = /gh[pousr]_[A-Za-z0-9]{36,}/;

export const secretGithubTokenRule: Rule = {
  id: 'secret.github_token',
  severity: 'critical',
  title: 'GitHub token committed',
  message:
    'This looks like a GitHub personal access, OAuth, user, or server token. Revoke it in GitHub settings and rotate immediately — a token committed to git must be treated as compromised.',
  languages: '*',
  test(ctx) {
    const findings: RuleFinding[] = [];
    for (const line of ctx.addedLines) {
      const match = GITHUB_TOKEN_PATTERN.exec(line.text);
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
