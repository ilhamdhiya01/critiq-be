import { runRuleAgainstFixture } from '../test-helpers';
import { codeEvalDynamicRule } from './code.eval-dynamic.rule';

describe('code.eval_dynamic', () => {
  it.each(['positive-1.ts', 'positive-2.py'])('flags %s', (fixture) => {
    const result = runRuleAgainstFixture(codeEvalDynamicRule, fixture);
    expect(result.hits.length).toBeGreaterThanOrEqual(1);
  });

  it.each(['negative-1.ts', 'negative-2.ts'])('does not flag %s', (fixture) => {
    const result = runRuleAgainstFixture(codeEvalDynamicRule, fixture);
    expect(result.hits).toHaveLength(0);
  });
});
