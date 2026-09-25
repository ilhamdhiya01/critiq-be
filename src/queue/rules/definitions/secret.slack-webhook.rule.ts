import { Rule, RuleFinding } from '../rule.interface';

const SLACK_WEBHOOK_PATTERN =
  /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+/;

export const secretSlackWebhookRule: Rule = {
  id: 'secret.slack_webhook',
  severity: 'critical',
  title: 'Slack webhook URL committed',
  message:
    'This is a live Slack incoming webhook URL — anyone with it can post messages to your workspace. Regenerate the webhook in Slack app settings and move the URL to an environment variable.',
  languages: '*',
  test(ctx) {
    const findings: RuleFinding[] = [];
    for (const line of ctx.addedLines) {
      const match = SLACK_WEBHOOK_PATTERN.exec(line.text);
      if (match) {
        findings.push({
          lineStart: line.newLine,
          lineEnd: line.newLine,
          snippet: 'https://hooks.slack.com/services/****',
        });
      }
    }
    return findings;
  },
};
