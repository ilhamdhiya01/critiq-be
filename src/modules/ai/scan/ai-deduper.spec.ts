import {
  FindingCategory,
  FindingSeverity,
  SuppressionReason,
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
    reportedSeverity: FindingSeverity.CRITICAL,
    ...overrides,
  };
}

const STATIC_SECRET = {
  id: 'f_static',
  filePath: 'src/aws.ts',
  lineStart: 3,
  lineEnd: 3,
  category: FindingCategory.SECRET,
  suppressedReason: null,
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
  // critiq-be PR #7: the rules had set these lines aside; the AI must not
  // bring them back as active criticals.
  it('inherits the reason of a suppressed static finding it overlaps', () => {
    const { kept, duplicates } = dedupeAiFindings(
      [ai({ lineStart: 5, lineEnd: 5 })],
      [{ ...STATIC_SECRET, suppressedReason: SuppressionReason.COMMENT }],
    );
    expect(duplicates).toHaveLength(0);
    expect(kept).toHaveLength(1);
    expect(kept[0].suppressedReason).toBe(SuppressionReason.COMMENT);
  });

  it('suppresses by path where a static finding of that family would be', () => {
    const [secretInSpec] = dedupeAiFindings(
      [ai({ filePath: 'src/aws.spec.ts' })],
      [],
    ).kept;
    expect(secretInSpec.suppressedReason).toBe(SuppressionReason.TEST_FILE);

    // eval/SQL/shell in a test file stay active, as the rules' do …
    const [injectionInSpec] = dedupeAiFindings(
      [ai({ filePath: 'src/db.spec.ts', category: FindingCategory.INJECTION })],
      [],
    ).kept;
    expect(injectionInSpec.suppressedReason).toBeNull();

    // … but fixtures are data for every family.
    const [injectionInFixture] = dedupeAiFindings(
      [
        ai({
          filePath: 'test/fixtures/query.ts',
          category: FindingCategory.INJECTION,
        }),
      ],
      [],
    ).kept;
    expect(injectionInFixture.suppressedReason).toBe(
      SuppressionReason.TEST_FILE,
    );
  });

  it('leaves an AI finding in ordinary code active', () => {
    const [finding] = dedupeAiFindings([ai()], []).kept;
    expect(finding.suppressedReason).toBeNull();
  });
});

describe('dedupeAiFindings — one finding per root cause', () => {
  const logic = (overrides: Partial<AiFindingDraft>) =>
    ai({
      filePath: 'src/form.js',
      category: FindingCategory.ERROR_HANDLING,
      severity: FindingSeverity.MINOR,
      ...overrides,
    });

  it('merges a hedged title into the plain one and spans both ranges', () => {
    const { kept, merged } = dedupeAiFindings(
      [
        logic({
          title: 'Potential missing error feedback',
          lineStart: 31,
          lineEnd: 31,
          confidence: 0.7,
        }),
        logic({
          title: 'Missing error feedback',
          lineStart: 24,
          lineEnd: 24,
          confidence: 0.8,
        }),
      ],
      [],
    );
    expect(merged).toBe(1);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({
      title: 'Missing error feedback', // most confident wins
      lineStart: 24,
      lineEnd: 31,
    });
  });

  it('merges near-identical titles in the same file and category', () => {
    const { kept } = dedupeAiFindings(
      [
        logic({
          title: 'No feedback when validation fails',
          lineStart: 24,
          lineEnd: 24,
        }),
        logic({
          title: 'No feedback when the validation fails',
          lineStart: 31,
          lineEnd: 31,
          confidence: 0.8,
        }),
      ],
      [],
    );
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ lineStart: 24, lineEnd: 31 });
  });

  it.each([
    ['a different problem', { title: 'Timer is never cleared' }],
    [
      'another category',
      {
        category: FindingCategory.LOGIC,
        title: 'No feedback when validation fails',
      },
    ],
    [
      'another file',
      { filePath: 'src/table.js', title: 'No feedback when validation fails' },
    ],
    [
      'too far apart',
      {
        title: 'No feedback when the validation fails',
        lineStart: 80,
        lineEnd: 80,
      },
    ],
  ])('keeps two findings for %s', (_, overrides) => {
    const { kept, merged } = dedupeAiFindings(
      [
        logic({
          title: 'No feedback when validation fails',
          lineStart: 24,
          lineEnd: 24,
        }),
        logic({ confidence: 0.8, ...overrides }),
      ],
      [],
    );
    expect(merged).toBe(0);
    expect(kept).toHaveLength(2);
  });

  it('fingerprints a hedged title like the plain one', () => {
    expect(aiFingerprint(ai({ title: 'Potential SQL injection' }))).toBe(
      aiFingerprint(ai({ title: 'SQL injection' })),
    );
  });
});
