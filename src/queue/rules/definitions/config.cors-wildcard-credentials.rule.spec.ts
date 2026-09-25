import { runRuleAgainstFixture } from '../test-helpers';
import { configCorsWildcardCredentialsRule } from './config.cors-wildcard-credentials.rule';

describe('config.cors_wildcard_credentials', () => {
  it.each(['positive-1.ts', 'positive-2.ts'])('flags %s', (fixture) => {
    const result = runRuleAgainstFixture(
      configCorsWildcardCredentialsRule,
      fixture,
    );
    expect(result.hits).toHaveLength(1);
  });

  it.each(['negative-1.ts', 'negative-2.ts', 'negative-3.ts'])(
    'does not flag %s',
    (fixture) => {
      const result = runRuleAgainstFixture(
        configCorsWildcardCredentialsRule,
        fixture,
      );
      expect(result.hits).toHaveLength(0);
    },
  );
});
