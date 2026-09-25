import { runRuleAgainstFixture } from '../test-helpers';
import { secretAwsAccessKeyRule } from './secret.aws-access-key.rule';

describe('secret.aws_access_key', () => {
  it.each(['positive-1.ts', 'positive-2.py'])('flags %s', (fixture) => {
    const result = runRuleAgainstFixture(secretAwsAccessKeyRule, fixture);
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].snippet).toBe('AKIA****');
  });

  it.each(['negative-1.ts', 'negative-2.ts'])('does not flag %s', (fixture) => {
    const result = runRuleAgainstFixture(secretAwsAccessKeyRule, fixture);
    expect(result.hits).toHaveLength(0);
  });
});
