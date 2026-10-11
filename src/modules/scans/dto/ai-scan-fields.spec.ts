import { AiScanStatus, RuleTier } from '../../../generated/prisma/enums';
import { ALL_RULE_TIERS } from '../../../queue/rules/rule-tiers';
import { AiScanFieldsRow, toApiAiScanFields } from './ai-scan-fields';

const row = (overrides: Partial<AiScanFieldsRow> = {}): AiScanFieldsRow => ({
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

describe('toApiAiScanFields — tiers', () => {
  it('reports nothing unchecked after an AI review', () => {
    expect(toApiAiScanFields(row()).uncheckedTiers).toEqual([]);
    expect(
      toApiAiScanFields(row({ aiStatus: AiScanStatus.CACHED })).uncheckedTiers,
    ).toEqual([]);
  });

  it('reports the enabled AI-only tiers when no AI review ran', () => {
    expect(
      toApiAiScanFields(row({ aiStatus: AiScanStatus.SKIPPED_MANUAL_MODE }))
        .uncheckedTiers,
    ).toEqual(['breaking_change', 'performance']);
    expect(
      toApiAiScanFields(
        row({ aiStatus: null, ruleTiers: [RuleTier.PERFORMANCE] }),
      ),
    ).toMatchObject({
      ruleTiers: ['performance'],
      uncheckedTiers: ['performance'],
    });
  });
});
