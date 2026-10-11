import {
  AiScanStatus,
  CiState,
  RuleTier,
  ScanStatus,
} from '../../generated/prisma/enums';
import { ALL_RULE_TIERS } from '../../queue/rules/rule-tiers';
import { aggregateCi, qualityGate, QualityGateInput } from './quality-gate';

const scan = (
  overrides: Partial<NonNullable<QualityGateInput['scan']>> = {},
): NonNullable<QualityGateInput['scan']> => ({
  status: ScanStatus.DONE,
  headSha: 'abc123',
  criticalCount: 0,
  aiStatus: AiScanStatus.DONE,
  aiErrorCode: null,
  aiProvider: 'openai',
  aiModel: 'gpt-4o-mini',
  aiCached: false,
  majorCount: 0,
  minorCount: 0,
  aiFindingsDropped: 0,
  aiReportedRiskLevel: null,
  ruleTiers: ALL_RULE_TIERS,
  ...overrides,
});

const gate = (overrides: Partial<QualityGateInput> = {}) =>
  qualityGate({
    pullHeadSha: 'abc123',
    scan: scan(),
    scanInFlight: false,
    ci: 'SUCCESS',
    ...overrides,
  });

describe('aggregateCi', () => {
  it.each([
    [[], 'NONE'],
    [[CiState.SUCCESS, CiState.SUCCESS], 'SUCCESS'],
    [[CiState.SUCCESS, CiState.PENDING], 'PENDING'],
    [[CiState.PENDING, CiState.FAILURE], 'FAILURE'],
  ])('%j → %s', (states, expected) => {
    expect(aggregateCi(states)).toBe(expected);
  });
});

describe('qualityGate', () => {
  it('passes with no critical and green CI', () => {
    expect(gate()).toEqual({
      status: 'passed',
      reasons: [],
      ci: 'success',
      uncheckedTiers: [],
    });
  });

  it('fails on an active critical, and on red CI', () => {
    expect(gate({ scan: scan({ criticalCount: 2 }) })).toMatchObject({
      status: 'failed',
      reasons: ['critical_findings'],
    });
    expect(gate({ ci: 'FAILURE' })).toMatchObject({
      status: 'failed',
      reasons: ['ci_failed'],
    });
  });

  it('ignores CI when the CI tier is off', () => {
    const noCi = ALL_RULE_TIERS.filter((tier) => tier !== RuleTier.CI);
    expect(gate({ ci: 'FAILURE', scan: scan({ ruleTiers: noCi }) })).toEqual(
      expect.objectContaining({ status: 'passed', reasons: [] }),
    );
  });

  it('waits for a running scan, AI review or pipeline', () => {
    expect(gate({ scanInFlight: true }).status).toBe('pending');
    expect(
      gate({ scan: scan({ aiStatus: AiScanStatus.RUNNING }) }).status,
    ).toBe('pending');
    expect(gate({ ci: 'PENDING' }).reasons).toEqual(['ci_running']);
    expect(gate({ pullHeadSha: 'def456' }).reasons).toEqual(['stale_scan']);
    expect(gate({ scan: null }).reasons).toEqual(['not_scanned']);
  });

  it('passes without CI, saying it found none', () => {
    expect(gate({ ci: 'NONE' })).toMatchObject({
      status: 'passed',
      reasons: ['ci_not_detected'],
      ci: 'none',
    });
  });

  it('lists AI-only tiers as unchecked without failing on them', () => {
    expect(
      gate({ scan: scan({ aiStatus: AiScanStatus.SKIPPED_MANUAL_MODE }) }),
    ).toMatchObject({
      status: 'passed',
      uncheckedTiers: ['breaking_change', 'performance'],
    });
  });

  it('fails a scan that failed', () => {
    expect(gate({ scan: scan({ status: ScanStatus.FAILED }) })).toMatchObject({
      status: 'failed',
      reasons: ['scan_failed'],
    });
  });
});
