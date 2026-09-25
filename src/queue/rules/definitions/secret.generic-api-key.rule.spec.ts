import { runRuleAgainstFixture } from '../test-helpers';
import { secretGenericApiKeyRule } from './secret.generic-api-key.rule';

describe('secret.generic_api_key', () => {
  it.each(['positive-1.ts', 'positive-2.py'])('flags %s', (fixture) => {
    const result = runRuleAgainstFixture(secretGenericApiKeyRule, fixture);
    expect(result.hits).toHaveLength(1);
  });

  it.each(['negative-1.ts', 'negative-2.ts'])('does not flag %s', (fixture) => {
    const result = runRuleAgainstFixture(secretGenericApiKeyRule, fixture);
    expect(result.hits).toHaveLength(0);
  });
});
