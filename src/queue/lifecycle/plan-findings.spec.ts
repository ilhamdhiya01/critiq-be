import {
  FindingCategory,
  FindingSeverity,
  FindingSource,
  FindingStatus,
} from '../../generated/prisma/enums';
import { CandidateFinding, planFindings, StoredFinding } from './plan-findings';

function stored(
  id: string,
  overrides: Partial<StoredFinding> = {},
): StoredFinding {
  return {
    id,
    source: FindingSource.STATIC,
    ruleId: 'code.sql_string_concat',
    severity: FindingSeverity.CRITICAL,
    title: 'SQL built by string concatenation',
    message: 'Use parameters.',
    filePath: 'src/auth/roles.ts',
    lineStart: 64,
    lineEnd: 64,
    snippet: 'db.query("x" + id)',
    fingerprint: `fp-${id}`,
    suppressedReason: null,
    category: FindingCategory.INJECTION,
    confidence: null,
    firstSeenScanId: 'scan_1',
    ...overrides,
  };
}

function candidate(
  overrides: Partial<CandidateFinding> = {},
): CandidateFinding {
  return {
    source: FindingSource.STATIC,
    ruleId: 'code.sql_string_concat',
    severity: FindingSeverity.CRITICAL,
    title: 'SQL built by string concatenation',
    message: 'Use parameters.',
    filePath: 'src/other.ts',
    lineStart: 3,
    lineEnd: 3,
    snippet: 'q("x" + y)',
    fingerprint: 'fp-cand',
    suppressedReason: null,
    category: FindingCategory.INJECTION,
    confidence: null,
    ...overrides,
  };
}

describe('planFindings', () => {
  it('marks every finding of a first scan NEW, first seen here', () => {
    const { rows } = planFindings({
      scanId: 'scan_1',
      candidates: [candidate()],
      recentResolved: [],
    });
    expect(rows).toEqual([
      expect.objectContaining({
        status: FindingStatus.NEW,
        firstSeenScanId: 'scan_1',
        originFindingId: null,
      }),
    ]);
  });

  it('carries, resolves and re-opens in one incremental step', () => {
    const { rows } = planFindings({
      scanId: 'scan_2',
      candidates: [
        // Re-found persisted finding (acceptance 12) — dropped.
        candidate({ fingerprint: 'fp-keep' }),
        // Same problem as the one this push resolved → REOPENED.
        candidate({
          fingerprint: 'fp-fixed',
          filePath: 'src/config.ts',
          lineStart: 47,
          lineEnd: 47,
        }),
      ],
      carry: {
        base: [
          stored('keep'),
          stored('fixed', {
            filePath: 'src/config.ts',
            lineStart: 47,
            lineEnd: 47,
          }),
        ],
        files: [
          {
            path: 'src/config.ts',
            previousPath: null,
            status: 'modified',
            patch: '@@ -47,1 +47,1 @@\n-old\n+new',
          },
        ],
      },
      recentResolved: [],
    });

    const byStatus = (status: FindingStatus) =>
      rows.filter((row) => row.status === status);
    expect(byStatus(FindingStatus.PERSISTED)).toEqual([
      expect.objectContaining({
        fingerprint: 'fp-keep',
        originFindingId: 'keep',
      }),
    ]);
    const [resolvedRow] = byStatus(FindingStatus.RESOLVED);
    expect(resolvedRow).toMatchObject({
      fingerprint: 'fp-fixed',
      resolvedInScanId: 'scan_2',
      originFindingId: 'fixed',
    });
    expect(byStatus(FindingStatus.REOPENED)).toEqual([
      expect.objectContaining({
        originFindingId: resolvedRow.id,
        firstSeenScanId: 'scan_1',
      }),
    ]);
    expect(byStatus(FindingStatus.NEW)).toEqual([]);
  });

  // Acceptance 13: outside the window the pool is empty → NEW.
  it('keeps a finding NEW when its old resolution is out of the window', () => {
    const { rows, newFingerprints } = planFindings({
      scanId: 'scan_6',
      candidates: [candidate({ fingerprint: 'fp-ancient' })],
      recentResolved: [],
    });
    expect(rows[0].status).toBe(FindingStatus.NEW);
    expect(newFingerprints).toEqual(['fp-ancient']);
  });
});
