import { runRuleAgainstFixture } from '../test-helpers';
import { secretSlackWebhookRule } from './secret.slack-webhook.rule';

describe('secret.slack_webhook', () => {
  it.each(['positive-1.ts', 'positive-2.py'])('flags %s', (fixture) => {
    const result = runRuleAgainstFixture(secretSlackWebhookRule, fixture);
    expect(result.hits).toHaveLength(1);
  });

  it.each(['negative-1.ts', 'negative-2.ts'])('does not flag %s', (fixture) => {
    const result = runRuleAgainstFixture(secretSlackWebhookRule, fixture);
    expect(result.hits).toHaveLength(0);
  });
});
