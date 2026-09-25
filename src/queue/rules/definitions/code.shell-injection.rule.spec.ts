import { runRuleAgainstFixture } from '../test-helpers';
import { codeShellInjectionRule } from './code.shell-injection.rule';

describe('code.shell_injection', () => {
  it.each(['positive-1.ts', 'positive-2.py'])('flags %s', (fixture) => {
    const result = runRuleAgainstFixture(codeShellInjectionRule, fixture);
    expect(result.hits).toHaveLength(1);
  });

  it.each(['negative-1.ts', 'negative-2.py', 'negative-3.ts'])(
    'does not flag %s',
    (fixture) => {
      const result = runRuleAgainstFixture(codeShellInjectionRule, fixture);
      expect(result.hits).toHaveLength(0);
    },
  );
});
