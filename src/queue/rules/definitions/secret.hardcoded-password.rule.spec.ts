import { runRuleAgainstFixture } from '../test-helpers';
import { secretHardcodedPasswordRule } from './secret.hardcoded-password.rule';

describe('secret.hardcoded_password', () => {
  it.each(['positive-1.ts', 'positive-2.py'])('flags %s', (fixture) => {
    const result = runRuleAgainstFixture(secretHardcodedPasswordRule, fixture);
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].snippet).toBeNull();
  });

  it('does not flag a placeholder value like <your-password>', () => {
    const result = runRuleAgainstFixture(
      secretHardcodedPasswordRule,
      'negative-1.ts',
    );
    expect(result.hits).toHaveLength(0);
  });

  it('does not flag a *.test.ts file even with a real-looking password', () => {
    const result = runRuleAgainstFixture(
      secretHardcodedPasswordRule,
      'negative-2.test.ts',
    );
    expect(result.hits).toHaveLength(0);
  });
});
