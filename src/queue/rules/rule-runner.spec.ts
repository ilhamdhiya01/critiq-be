import { Rule } from './rule.interface';
import { runRulesForFile } from './rule-runner';

const baseRule = {
  severity: 'critical' as const,
  title: 't',
  message: 'm',
  languages: '*' as const,
};

const lines = [{ newLine: 1, text: 'hello' }];

describe('runRulesForFile', () => {
  it('isolates a crashing rule and still runs the others', () => {
    const crashing: Rule = {
      ...baseRule,
      id: 'test.crash',
      test: () => {
        throw new TypeError('boom');
      },
    };
    const working: Rule = {
      ...baseRule,
      id: 'test.ok',
      test: () => [{ lineStart: 1, lineEnd: 1, snippet: 'hello' }],
    };

    const result = runRulesForFile([crashing, working], 'a.ts', 'js', lines, {
      elapsedMs: 0,
    });

    expect(result.ruleRuns).toBe(2);
    expect(result.crashes).toEqual([
      { ruleId: 'test.crash', errorName: 'TypeError' },
    ]);
    expect(result.hits.map((hit) => hit.ruleId)).toEqual(['test.ok']);
  });

  it('skips rules whose languages do not match the file', () => {
    const pyOnly: Rule = {
      ...baseRule,
      id: 'test.py',
      languages: ['py'],
      test: () => [{ lineStart: 1, lineEnd: 1, snippet: null }],
    };

    const result = runRulesForFile([pyOnly], 'a.ts', 'js', lines, {
      elapsedMs: 0,
    });

    expect(result.ruleRuns).toBe(0);
    expect(result.hits).toHaveLength(0);
  });

  it('stops immediately once the scan-wide budget is already spent', () => {
    const rule: Rule = {
      ...baseRule,
      id: 'test.ok',
      test: () => [{ lineStart: 1, lineEnd: 1, snippet: null }],
    };

    const result = runRulesForFile([rule], 'a.ts', 'js', lines, {
      elapsedMs: 10_000,
    });

    expect(result.budgetExceeded).toBe(true);
    expect(result.ruleRuns).toBe(0);
  });
});
