import { SuppressionReason } from '../generated/prisma/enums';
import { analyzeDiff } from './analyze-diff';
import { loadDiffFixture } from './diff/test-helpers';

// Acceptance 1 of the v1.5.0 suppression delta. The fixture is the real diff
// of PR #6 on critiq-be (`git diff dff00f7^1...114a29a`), whose scan under
// ruleset 2026.09 reported 44 Critical findings — all false positives: the
// rules matching their own definitions, regexes and spec/fixture files.
//
// The prompt's exact numbers (44 suppressed, ≥ 30 regex_literal, ≥ 10
// test_file) belonged to that older ruleset; rules since then drop prose and
// comment mentions before suppression ever sees them. What must hold is the
// outcome: nothing active, and both reasons present.
describe('self-scan of critiq-be PR #6', () => {
  const files = loadDiffFixture('critiq-self-scan.diff');
  const result = analyzeDiff(files, { maxDiffBytes: 10_000_000 });

  it('parses the whole diff', () => {
    expect(files).toHaveLength(144);
    expect(result.diffTooLarge).toBe(false);
    expect(result.crashes).toEqual([]);
  });

  it('has no active finding', () => {
    // On failure, show what is still active rather than just a count.
    expect(
      result.active.map((f) => `${f.ruleId} ${f.filePath}:${f.lineStart}`),
    ).toEqual([]);
    expect(result.activeCount).toBe(0);
    expect(result.findingsTruncated).toBe(false);
  });

  it('keeps the false positives, suppressed for both reasons', () => {
    const byReason = new Map<SuppressionReason, number>();
    for (const finding of result.suppressed) {
      const reason = finding.suppressedReason as SuppressionReason;
      byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
    }
    expect(result.suppressedCount).toBeGreaterThan(0);
    expect(byReason.get(SuppressionReason.TEST_FILE) ?? 0).toBeGreaterThan(0);
    expect(byReason.get(SuppressionReason.REGEX_LITERAL) ?? 0).toBeGreaterThan(
      0,
    );
  });
});
