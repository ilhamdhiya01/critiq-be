import { SuppressionReason } from '../../../generated/prisma/enums';
import { classifySuppression } from '../../suppression';
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

  it('reports a *.test.ts token, which the processor suppresses', () => {
    const result = runRuleAgainstFixture(
      secretJwtLiteralRule,
      'negative-2.test.ts',
    );
    expect(result.hits).toHaveLength(1);
    expect(
      classifySuppression({
        ruleId: secretJwtLiteralRule.id,
        filePath: 'src/negative-2.test.ts',
        language: 'js',
      }),
    ).toBe(SuppressionReason.TEST_FILE);
  });
});
