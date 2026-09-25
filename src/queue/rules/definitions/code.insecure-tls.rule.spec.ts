import { runRuleAgainstFixture } from '../test-helpers';
import { codeInsecureTlsRule } from './code.insecure-tls.rule';

describe('code.insecure_tls', () => {
  it.each(['positive-1.ts', 'positive-2.py'])('flags %s', (fixture) => {
    const result = runRuleAgainstFixture(codeInsecureTlsRule, fixture);
    expect(result.hits).toHaveLength(1);
  });

  it.each(['negative-1.ts', 'negative-2.py'])('does not flag %s', (fixture) => {
    const result = runRuleAgainstFixture(codeInsecureTlsRule, fixture);
    expect(result.hits).toHaveLength(0);
  });
});
