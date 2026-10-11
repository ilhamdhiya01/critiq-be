import { SuppressionReason } from '../../../generated/prisma/enums';
import { classifySuppression } from '../../suppression';
import { runRuleAgainstFixture } from '../test-helpers';
import { codeEmptyCatchRule } from './code.empty-catch.rule';

const onPath = (filePath: string) => ({ filePath });

describe('code.empty_catch', () => {
  it.each([
    ['positive-1.ts', 'src/auth/session.ts', 4, 4],
    ['positive-2.ts', 'src/payments/charge.ts', 4, 5],
    ['positive-3.ts', 'src/oauth/refresh.ts', 1, 1],
    ['positive-4.py', 'app/auth/login.py', 4, 5],
  ])('flags %s on %s', (fixture, path, lineStart, lineEnd) => {
    const result = runRuleAgainstFixture(
      codeEmptyCatchRule,
      fixture,
      onPath(path),
    );
    expect(result.hits).toEqual([
      expect.objectContaining({ lineStart, lineEnd }),
    ]);
  });

  it('leaves the same code alone off a critical path', () => {
    const result = runRuleAgainstFixture(
      codeEmptyCatchRule,
      'positive-1.ts',
      onPath('src/reports/export.ts'),
    );
    expect(result.hits).toHaveLength(0);
  });

  // A rethrow, an empty handler with a comment saying why, and best-effort
  // cleanup whose result nobody reads.
  it.each(['negative-1.ts', 'negative-2.ts', 'negative-3.ts'])(
    'does not flag %s',
    (fixture) => {
      const result = runRuleAgainstFixture(
        codeEmptyCatchRule,
        fixture,
        onPath('src/auth/session.ts'),
      );
      expect(result.hits).toHaveLength(0);
    },
  );

  it('is suppressed in tests', () => {
    expect(
      classifySuppression({
        ruleId: codeEmptyCatchRule.id,
        filePath: 'src/auth/session.spec.ts',
        language: 'js',
      }),
    ).toBe(SuppressionReason.TEST_FILE);
  });
});
