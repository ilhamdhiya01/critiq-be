import {
  assignNewOrReopened,
  dropPersistedDuplicates,
  matchFullAgainstBase,
  ResolvedFinding,
} from './status-matcher';

const RESOLVED_110: ResolvedFinding = {
  id: 'r1',
  source: 'AI',
  filePath: 'src/auth/session.ts',
  lineStart: 110,
  category: 'ERROR_HANDLING',
  title: 'Missing error handling in rotation path',
  fingerprint: 'fp-old',
  firstSeenScanId: 'scan_1',
};

function candidate(overrides: Partial<ResolvedFinding> = {}) {
  return {
    source: 'AI',
    filePath: 'src/auth/session.ts',
    lineStart: 110,
    category: 'ERROR_HANDLING',
    title: 'Swallowed promise rejection in rotation path',
    fingerprint: 'fp-new',
    ...overrides,
  };
}

describe('assignNewOrReopened', () => {
  it('re-opens on the same fingerprint', () => {
    const [result] = assignNewOrReopened(
      [candidate({ fingerprint: 'fp-old', title: 'anything' })],
      [RESOLVED_110],
    );
    expect(result.reopens?.id).toBe('r1');
  });

  // Acceptance 3: a partial fix, re-reported with a similar title.
  it('re-opens a similar finding at about the same place', () => {
    const [result] = assignNewOrReopened(
      [
        candidate({
          title: 'Missing error handling in the rotation path',
          lineStart: 112,
        }),
      ],
      [RESOLVED_110],
    );
    expect(result.reopens?.firstSeenScanId).toBe('scan_1');
  });

  // Acceptance 4.
  it('treats another category as new', () => {
    const [result] = assignNewOrReopened(
      [
        candidate({
          category: 'LOGIC',
          title: 'Missing error handling in rotation path',
        }),
      ],
      [RESOLVED_110],
    );
    expect(result.reopens).toBeNull();
  });

  it('needs the lines within 5 and the titles close', () => {
    const far = assignNewOrReopened(
      [candidate({ title: RESOLVED_110.title, lineStart: 120 })],
      [RESOLVED_110],
    );
    const unlike = assignNewOrReopened(
      [candidate({ title: 'Unbounded retry loop' })],
      [RESOLVED_110],
    );
    expect(far[0].reopens).toBeNull();
    expect(unlike[0].reopens).toBeNull();
  });

  it('re-opens each resolved finding at most once', () => {
    const results = assignNewOrReopened(
      [
        candidate({ fingerprint: 'fp-old' }),
        candidate({ fingerprint: 'fp-old' }),
      ],
      [RESOLVED_110],
    );
    expect(results.map((r) => r.reopens?.id ?? null)).toEqual(['r1', null]);
  });
});

// Acceptance 12.
describe('dropPersistedDuplicates', () => {
  it('drops a candidate already carried as persisted', () => {
    expect(
      dropPersistedDuplicates(
        [{ fingerprint: 'sql-64' }, { fingerprint: 'other' }],
        [{ fingerprint: 'sql-64' }],
      ),
    ).toEqual([{ fingerprint: 'other' }]);
  });
});

// Acceptance 5.
describe('matchFullAgainstBase', () => {
  it('persists matches, resolves what is gone, keeps the rest fresh', () => {
    const { persisted, fresh, resolved } = matchFullAgainstBase(
      [{ fingerprint: 'same' }, { fingerprint: 'brand-new' }],
      [
        { id: 'b1', fingerprint: 'same' },
        { id: 'b2', fingerprint: 'fixed' },
      ],
    );
    expect(persisted.map((p) => p.base.id)).toEqual(['b1']);
    expect(fresh).toEqual([{ fingerprint: 'brand-new' }]);
    expect(resolved.map((r) => r.id)).toEqual(['b2']);
  });
});
