import { runRuleAgainstFixture } from '../test-helpers';
import { secretDbUrlWithPasswordRule } from './secret.db-url-with-password.rule';

describe('secret.db_url_with_password', () => {
  it('flags a plain postgres:// URL with an embedded password', () => {
    const result = runRuleAgainstFixture(
      secretDbUrlWithPasswordRule,
      'positive-1.ts',
    );
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].snippet).toBe('postgres://****:****@');
  });

  it('flags a mongodb+srv:// URL with an embedded password', () => {
    const result = runRuleAgainstFixture(
      secretDbUrlWithPasswordRule,
      'positive-2.py',
    );
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].snippet).toBe('mongodb+srv://****:****@');
  });

  it.each(['negative-1.ts', 'negative-2.ts', 'negative-3.ts'])(
    'does not flag %s',
    (fixture) => {
      const result = runRuleAgainstFixture(
        secretDbUrlWithPasswordRule,
        fixture,
      );
      expect(result.hits).toHaveLength(0);
    },
  );
});
