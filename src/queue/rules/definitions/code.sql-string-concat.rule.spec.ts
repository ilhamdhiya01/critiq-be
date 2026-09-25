import { runRuleAgainstFixture } from '../test-helpers';
import { codeSqlStringConcatRule } from './code.sql-string-concat.rule';

describe('code.sql_string_concat', () => {
  it.each(['positive-1.ts', 'positive-2.ts'])('flags %s', (fixture) => {
    const result = runRuleAgainstFixture(codeSqlStringConcatRule, fixture);
    expect(result.hits).toHaveLength(1);
  });

  it.each(['negative-1.ts', 'negative-2.ts'])('does not flag %s', (fixture) => {
    const result = runRuleAgainstFixture(codeSqlStringConcatRule, fixture);
    expect(result.hits).toHaveLength(0);
  });
});
