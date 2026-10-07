import {
  FindingCategory,
  FindingSeverity,
  FindingSource,
  FindingStatus,
  SuppressionReason,
} from '../../../generated/prisma/enums';
import { FindingRow } from '../../../queue/lifecycle/plan-findings';
import {
  isComparableRun,
  mergeWithPreviousRun,
  PreviousRunFinding,
} from './regenerate-merge';

jest.mock('../../../generated/prisma/client', () => ({ Prisma: {} }));

function row(overrides: Partial<FindingRow> = {}): FindingRow {
  return {
    id: 'new_1',
    source: FindingSource.AI,
    ruleId: 'ai.config',
    severity: FindingSeverity.MAJOR,
    title: 'Developer mode flag hardcoded to true',
    message: 'Ships with developer mode on.',
    filePath: 'src/redux/constants/demoData.js',
    lineStart: 4,
    lineEnd: 4,
    snippet: null,
    fingerprint: 'fp-dev-mode',
    suppressedReason: null,
    category: FindingCategory.CONFIG,
    confidence: 0.85,
    reportedSeverity: FindingSeverity.MAJOR,
    dedupeOfId: null,
    status: FindingStatus.NEW,
    firstSeenScanId: 'scan_2',
    originFindingId: null,
    resolvedInScanId: null,
    ...overrides,
  };
}

function earlier(
  overrides: Partial<PreviousRunFinding> = {},
): PreviousRunFinding {
  return {
    id: 'old_1',
    source: FindingSource.AI,
    ruleId: 'ai.config',
    severity: FindingSeverity.CRITICAL,
    title: 'Developer mode flag hardcoded to true',
    message: 'Ships with developer mode on.',
    filePath: 'src/redux/constants/demoData.js',
    lineStart: 4,
    lineEnd: 4,
    snippet: null,
    fingerprint: 'fp-dev-mode',
    suppressedReason: null,
    category: FindingCategory.CONFIG,
    confidence: 0.9,
    reportedSeverity: FindingSeverity.CRITICAL,
    firstSeenScanId: 'scan_1',
    status: FindingStatus.NEW,
    originFindingId: null,
    ...overrides,
  };
}

describe('mergeWithPreviousRun', () => {
  // MR !1792: critical on the first generate, major on the regenerate.
  it('keeps the higher severity and records both runs', () => {
    const { rows, stats } = mergeWithPreviousRun(
      [row()],
      [earlier()],
      'same_scan',
    );
    expect(rows).toEqual([
      expect.objectContaining({
        severity: FindingSeverity.CRITICAL,
        previousRunSeverity: FindingSeverity.CRITICAL,
        latestRunSeverity: FindingSeverity.MAJOR,
        status: FindingStatus.NEW,
      }),
    ]);
    expect(stats).toEqual({ matched: 1, escalated: 1, notReproduced: 0 });
  });

  it('takes the latest when it is the higher one', () => {
    const { rows, stats } = mergeWithPreviousRun(
      [row({ severity: FindingSeverity.CRITICAL })],
      [earlier({ severity: FindingSeverity.MAJOR })],
      'same_scan',
    );
    expect(rows[0]).toMatchObject({
      severity: FindingSeverity.CRITICAL,
      previousRunSeverity: FindingSeverity.MAJOR,
      latestRunSeverity: FindingSeverity.CRITICAL,
    });
    expect(stats.escalated).toBe(0);
  });

  it('leaves an agreeing finding unmarked', () => {
    const { rows } = mergeWithPreviousRun(
      [row({ severity: FindingSeverity.CRITICAL })],
      [earlier()],
      'same_scan',
    );
    expect(rows[0]).toMatchObject({
      severity: FindingSeverity.CRITICAL,
      previousRunSeverity: null,
      latestRunSeverity: null,
    });
  });

  // Agreeing now does not erase an earlier disagreement.
  it('keeps a disagreement recorded by an earlier regenerate', () => {
    const { rows } = mergeWithPreviousRun(
      [row({ severity: FindingSeverity.CRITICAL })],
      [
        earlier({
          previousRunSeverity: FindingSeverity.CRITICAL,
          latestRunSeverity: FindingSeverity.MAJOR,
        }),
      ],
      'same_scan',
    );
    expect(rows[0]).toMatchObject({
      previousRunSeverity: FindingSeverity.CRITICAL,
      latestRunSeverity: FindingSeverity.MAJOR,
    });
  });

  it('matches a reworded title at about the same place', () => {
    const { stats } = mergeWithPreviousRun(
      [
        row({
          fingerprint: 'fp-other-wording',
          title: 'Developer mode flag hard-coded to true',
          lineStart: 5,
        }),
      ],
      [earlier()],
      'same_scan',
    );
    expect(stats.matched).toBe(1);
  });

  it('keeps an earlier finding the latest run dropped, flagged', () => {
    const { rows, stats } = mergeWithPreviousRun([], [earlier()], 'same_scan');
    expect(rows).toEqual([
      expect.objectContaining({
        severity: FindingSeverity.CRITICAL,
        notReproduced: true,
        // Same scan: the same finding, rewritten as it was.
        status: FindingStatus.NEW,
        firstSeenScanId: 'scan_1',
        originFindingId: null,
        suppressedReason: null,
        confidence: 0.9,
      }),
    ]);
    expect(stats).toEqual({ matched: 0, escalated: 0, notReproduced: 1 });
  });

  it('adds what only the latest run found', () => {
    const { rows } = mergeWithPreviousRun(
      [
        row({
          fingerprint: 'fp-new',
          title: 'Missing nullish defaults',
          category: FindingCategory.LOGIC,
          filePath: 'src/table.js',
        }),
      ],
      [],
      'same_scan',
    );
    expect(rows).toEqual([
      expect.objectContaining({ title: 'Missing nullish defaults' }),
    ]);
  });

  it('pairs each earlier finding with one new finding at most', () => {
    const { rows, stats } = mergeWithPreviousRun(
      [row({ id: 'a' }), row({ id: 'b', lineStart: 6 })],
      [earlier()],
      'same_scan',
    );
    expect(stats.matched).toBe(1);
    expect(rows).toHaveLength(2);
  });

  it('leaves suppressed, resolved and static rows alone', () => {
    const untouched = [
      row({ id: 's', suppressedReason: SuppressionReason.TEST_FILE }),
      row({ id: 'r', status: FindingStatus.RESOLVED }),
      row({ id: 'st', source: FindingSource.STATIC }),
    ];
    const { rows } = mergeWithPreviousRun(untouched, [earlier()], 'same_scan');
    expect(rows.slice(0, 3)).toEqual(untouched);
    expect(rows[3]).toMatchObject({ notReproduced: true });
  });

  // A new scan of the same commit (rescan, forced regenerate): the
  // lifecycle had matched or resolved the base findings.
  describe('against the base scan', () => {
    it('carries a dropped base finding instead of resolving it', () => {
      const resolved = row({
        id: 'res',
        status: FindingStatus.RESOLVED,
        originFindingId: 'old_1',
        resolvedInScanId: 'scan_2',
      });
      const { rows } = mergeWithPreviousRun(
        [resolved],
        [earlier()],
        'base_scan',
      );
      expect(rows).toEqual([
        expect.objectContaining({
          notReproduced: true,
          status: FindingStatus.PERSISTED,
          originFindingId: 'old_1',
          firstSeenScanId: 'scan_1',
          resolvedInScanId: null,
        }),
      ]);
    });

    it('continues a base finding matched only by similarity', () => {
      const { rows } = mergeWithPreviousRun(
        [
          row({
            fingerprint: 'fp-other-wording',
            title: 'Developer mode flag hard-coded to true',
          }),
          row({
            id: 'res',
            status: FindingStatus.RESOLVED,
            originFindingId: 'old_1',
          }),
        ],
        [earlier()],
        'base_scan',
      );
      expect(rows).toEqual([
        expect.objectContaining({
          status: FindingStatus.PERSISTED,
          originFindingId: 'old_1',
          firstSeenScanId: 'scan_1',
          severity: FindingSeverity.CRITICAL,
        }),
      ]);
    });
  });
});

describe('isComparableRun', () => {
  const run = (model: string | null, promptVersion = 'ai-2026.10.1') => ({
    provider: 'openai',
    model,
    promptVersion,
  });

  it.each([
    ['the same model', 'gpt-4o-mini', 'gpt-4o-mini', true],
    ['a dated snapshot', 'gpt-4o-mini-2024-07-18', 'gpt-4o-mini', true],
    ['a compact date', 'claude-haiku-4-5-20251001', 'claude-haiku-4-5', true],
    ['a longer name sharing a prefix', 'gpt-4o-mini', 'gpt-4o', false],
    ['another model', 'gpt-4.1', 'gpt-4o-mini', false],
  ])('%s', (_label, earlierModel, currentModel, expected) => {
    expect(isComparableRun(run(earlierModel), run(currentModel))).toBe(
      expected,
    );
  });

  it('needs the same prompt version and provider', () => {
    expect(isComparableRun(run('gpt-4o', 'ai-2026.09.4'), run('gpt-4o'))).toBe(
      false,
    );
    expect(
      isComparableRun(
        { ...run('gpt-4o'), provider: 'openai_compatible' },
        run('gpt-4o'),
      ),
    ).toBe(false);
  });

  it('never matches a scan with no earlier run', () => {
    expect(isComparableRun(run(null), run('gpt-4o'))).toBe(false);
  });
});
