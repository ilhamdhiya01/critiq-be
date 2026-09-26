import { runRuleAgainstFixture } from '../test-helpers';
import { secretAssignmentLiteralRule } from './secret.assignment-literal.rule';

describe('secret.assignment_literal', () => {
  // One fixture per syntax family, since a rule that only handles quoted
  // JS assignments is exactly the bug this rule exists to fix.
  it.each([
    ['positive-1.ts', 3, 'JS quotes: double, single, backtick'],
    ['positive-2.env', 3, 'unquoted .env — the originally-missed case'],
    ['positive-3.yml', 2, 'YAML key: value'],
    ['positive-4.sh', 2, 'shell export and -D java arg'],
    ['positive-5.go', 1, 'Go :='],
    ['positive-6.json', 1, 'JSON "key": "value"'],
  ])('flags %s (%i finding(s): %s)', (fixture, expected) => {
    const result = runRuleAgainstFixture(secretAssignmentLiteralRule, fixture);
    expect(result.hits).toHaveLength(expected);
  });

  // Acceptance 16's exact line.
  it('flags GITHUB_SECRET in an unquoted .env assignment', () => {
    const result = runRuleAgainstFixture(
      secretAssignmentLiteralRule,
      'positive-2.env',
    );
    const hit = result.hits.find((h) => h.snippet?.startsWith('GITHUB_SECRET'));
    expect(hit).toBeDefined();
    expect(hit?.snippet).toBe('GITHUB_SECRET=akjs****');
  });

  // Acceptance 17: the value must never survive into anything persisted.
  it('redacts the value to four characters in every snippet', () => {
    const result = runRuleAgainstFixture(
      secretAssignmentLiteralRule,
      'positive-2.env',
    );
    for (const hit of result.hits) {
      expect(hit.snippet).toMatch(/^[A-Z0-9_.-]+=.{0,4}\*\*\*\*$/i);
      expect(hit.snippet!.length).toBeLessThanOrEqual(120);
    }
    const serialized = JSON.stringify(result.hits);
    expect(serialized).not.toContain('akjsbdkajsbkjabskdjbaskdjbskjdf');
    expect(serialized).not.toContain('akjsbdk');
  });

  // Acceptance 18. These are rejected by ValueFilter, which the runner
  // applies — so this asserts the rule and filter work together, not the
  // regex alone.
  it.each([
    ['negative-1.env', 'env ref, placeholder, digits-only, UUID'],
    ['negative-2.ts', 'process.env, repeated chars, semver, <placeholder>'],
  ])('does not flag %s (%s)', (fixture) => {
    const result = runRuleAgainstFixture(secretAssignmentLiteralRule, fixture);
    expect(result.hits).toHaveLength(0);
    // Every line should have been considered and then rejected, not simply
    // missed by the regex — otherwise this passes for the wrong reason.
    expect(result.filtered.length).toBeGreaterThan(0);
  });

  // Acceptance 16's second half: the same line in an example file is noise.
  it('does not flag a credential in .env.example', () => {
    const result = runRuleAgainstFixture(
      secretAssignmentLiteralRule,
      'positive-2.env',
      { filePath: '.env.example' },
    );
    expect(result.hits).toHaveLength(0);
    expect(result.ruleRuns).toBe(0);
  });

  it('still flags the same line in a real .env', () => {
    const result = runRuleAgainstFixture(
      secretAssignmentLiteralRule,
      'positive-2.env',
      { filePath: '.env' },
    );
    expect(result.hits).toHaveLength(3);
  });
});
