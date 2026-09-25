import { runRuleAgainstFixture } from '../test-helpers';
import { secretJwtLiteralRule } from './secret.jwt-literal.rule';

describe('secret.jwt_literal', () => {
  it.each(['positive-1.ts', 'positive-2.py'])('flags %s', (fixture) => {
    const result = runRuleAgainstFixture(secretJwtLiteralRule, fixture);
    expect(result.hits).toHaveLength(1);
  });

  it('does not flag a token read from an env var', () => {
    const result = runRuleAgainstFixture(secretJwtLiteralRule, 'negative-1.ts');
    expect(result.hits).toHaveLength(0);
  });

  it('does not flag a *.test.ts fixture token', () => {
    const result = runRuleAgainstFixture(
      secretJwtLiteralRule,
      'negative-2.test.ts',
    );
    expect(result.hits).toHaveLength(0);
  });
});
