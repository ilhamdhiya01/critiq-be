import { runRuleAgainstFixture } from '../test-helpers';
import { secretPrivateKeyBlockRule } from './secret.private-key-block.rule';

describe('secret.private_key_block', () => {
  it.each(['positive-1.txt', 'positive-2.txt'])('flags %s', (fixture) => {
    const result = runRuleAgainstFixture(secretPrivateKeyBlockRule, fixture);
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].snippet).toBeNull();
  });

  it.each(['negative-1.txt', 'negative-2.txt'])(
    'does not flag %s',
    (fixture) => {
      const result = runRuleAgainstFixture(secretPrivateKeyBlockRule, fixture);
      expect(result.hits).toHaveLength(0);
    },
  );
});
