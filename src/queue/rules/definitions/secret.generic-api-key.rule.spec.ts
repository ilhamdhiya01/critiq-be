import { runRuleAgainstFixture } from '../test-helpers';
import { secretGenericApiKeyRule } from './secret.generic-api-key.rule';

describe('secret.generic_api_key', () => {
  // positive-3 is a bare `*_SECRET` name, which the rule missed while it
  // required the `_key` suffix.
  it.each(['positive-1.ts', 'positive-2.py', 'positive-3.ts'])(
    'flags %s',
    (fixture) => {
      const result = runRuleAgainstFixture(secretGenericApiKeyRule, fixture);
      expect(result.hits).toHaveLength(1);
    },
  );

  // negative-3 guards the bare-`secret` branch against identifiers that only
  // start with the word (secretPath, secretName).
  it.each(['negative-1.ts', 'negative-2.ts', 'negative-3.ts'])(
    'does not flag %s',
    (fixture) => {
      const result = runRuleAgainstFixture(secretGenericApiKeyRule, fixture);
      expect(result.hits).toHaveLength(0);
    },
  );
});
