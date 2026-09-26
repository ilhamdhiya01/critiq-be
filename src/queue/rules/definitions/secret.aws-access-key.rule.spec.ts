import { runRuleAgainstFixture } from '../test-helpers';
import { secretAwsAccessKeyRule } from './secret.aws-access-key.rule';

describe('secret.aws_access_key', () => {
  it.each(['positive-1.ts', 'positive-2.py'])('flags %s', (fixture) => {
    const result = runRuleAgainstFixture(secretAwsAccessKeyRule, fixture);
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].snippet).toBe('AKIA****');
  });

  it.each(['negative-1.ts', 'negative-2.ts'])('does not flag %s', (fixture) => {
    const result = runRuleAgainstFixture(secretAwsAccessKeyRule, fixture);
    expect(result.hits).toHaveLength(0);
  });

  // Acceptance 27. AKIAIOSFODNN7EXAMPLE is AWS's published example key, so
  // it reads exactly like a placeholder — ValueFilter would discard it for
  // containing "EXAMPLE". The rule opts out of the filter precisely so a
  // key in this shape is still reported wherever it appears.
  it("flags AWS's own example key despite it looking like a placeholder", () => {
    const result = runRuleAgainstFixture(
      secretAwsAccessKeyRule,
      'positive-3.ts',
    );
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].snippet).toBe('AKIA****');
    expect(result.filtered).toHaveLength(0);
  });
});
