import {
  FindingCategory,
  FindingSeverity,
} from '../../../generated/prisma/enums';
import { aiFingerprint, dedupeAiFindings } from './ai-deduper';
import { AiFindingDraft } from './ai-result-validator';

function ai(overrides: Partial<AiFindingDraft> = {}): AiFindingDraft {
  return {
    filePath: 'src/aws.ts',
    lineStart: 3,
    lineEnd: 3,
    category: FindingCategory.SECRET,
    severity: FindingSeverity.CRITICAL,
    title: 'Hardcoded AWS key',
    message: 'An AWS access key is committed in source code.',
    confidence: 0.95,
    ...overrides,
  };
}

const STATIC_SECRET = {
  id: 'f_static',
  filePath: 'src/aws.ts',
  lineStart: 3,
  lineEnd: 3,
  category: FindingCategory.SECRET,
};

describe('dedupeAiFindings', () => {
  // Acceptance 4.
  it('drops an AI finding on the same lines and category as a static one', () => {
    const { kept, duplicates } = dedupeAiFindings([ai()], [STATIC_SECRET]);
    expect(kept).toEqual([]);
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0].dedupeOfId).toBe('f_static');
  });

  // Acceptance 5.
  it('keeps an AI finding on the same lines with another category', () => {
    const { kept } = dedupeAiFindings(
      [
        ai({
          category: FindingCategory.ERROR_HANDLING,
          title: 'No error handling',
        }),
      ],
      [STATIC_SECRET],
    );
    expect(kept).toHaveLength(1);
  });

  it('uses ±2 lines of slack', () => {
    expect(
      dedupeAiFindings([ai({ lineStart: 5, lineEnd: 5 })], [STATIC_SECRET])
        .kept,
    ).toEqual([]);
    expect(
      dedupeAiFindings([ai({ lineStart: 6, lineEnd: 6 })], [STATIC_SECRET])
        .kept,
    ).toHaveLength(1);
  });

  it('keeps the most confident of AI findings sharing a fingerprint', () => {
    const { kept } = dedupeAiFindings(
      [
        ai({
          category: FindingCategory.LOGIC,
          title: 'Off-by-one!',
          confidence: 0.6,
        }),
        ai({
          category: FindingCategory.LOGIC,
          title: 'off by one',
          confidence: 0.8,
          lineStart: 4,
          lineEnd: 4,
        }),
      ],
      [],
    );
    expect(kept).toHaveLength(1);
    expect(kept[0].confidence).toBe(0.8);
    expect(kept[0].fingerprint).toBe(aiFingerprint(kept[0]));
  });
});
