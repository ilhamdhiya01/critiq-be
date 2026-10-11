import { runRuleAgainstFixture } from '../test-helpers';
import { secretEnvFallbackRule } from './secret.env-fallback.rule';

describe('secret.env_fallback', () => {
  it.each(['positive-1.ts', 'positive-2.py', 'positive-3.js'])(
    'flags %s',
    (fixture) => {
      const result = runRuleAgainstFixture(secretEnvFallbackRule, fixture);
      expect(result.hits).toHaveLength(1);
      expect(result.hits[0].snippet).toBeNull();
    },
  );

  // A non-secret setting with a default, and a secret with no fallback.
  it.each(['negative-1.ts', 'negative-2.ts'])('does not flag %s', (fixture) => {
    const result = runRuleAgainstFixture(secretEnvFallbackRule, fixture);
    expect(result.hits).toHaveLength(0);
  });
});
