import { runRuleAgainstFixture } from '../test-helpers';
import { codeDebuggerLeftRule } from './code.debugger-left.rule';

describe('code.debugger_left', () => {
  it.each(['positive-1.ts', 'positive-2.py'])('flags %s', (fixture) => {
    const result = runRuleAgainstFixture(codeDebuggerLeftRule, fixture);
    expect(result.hits).toHaveLength(1);
  });

  it.each(['negative-1.ts', 'negative-2.py'])('does not flag %s', (fixture) => {
    const result = runRuleAgainstFixture(codeDebuggerLeftRule, fixture);
    expect(result.hits).toHaveLength(0);
  });
});
