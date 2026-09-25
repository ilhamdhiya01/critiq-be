import { Rule, RuleFinding } from '../rule.interface';

const GITLAB_TOKEN_PATTERN = /glpat-[A-Za-z0-9\-_]{20,}/;

export const secretGitlabTokenRule: Rule = {
  id: 'secret.gitlab_token',
  severity: 'critical',
  title: 'GitLab personal/project access token committed',
  message:
    'This looks like a GitLab access token. Revoke it in GitLab settings and rotate immediately — a token committed to git must be treated as compromised.',
  languages: '*',
  test(ctx) {
    const findings: RuleFinding[] = [];
    for (const line of ctx.addedLines) {
      const match = GITLAB_TOKEN_PATTERN.exec(line.text);
      if (match) {
        findings.push({
          lineStart: line.newLine,
          lineEnd: line.newLine,
          snippet: match[0].slice(0, 6) + '****',
        });
      }
    }
    return findings;
  },
};
