import { FindingSeverity } from '../../../generated/prisma/enums';
import { dedupeAiFindings } from './ai-deduper';
import { SentFile } from './ai-prompt-builder';
import { ReportReviewInput } from './ai-prompt.constants';
import { validateAiFindings } from './ai-result-validator';
import { riskLevelFromCounts } from './ai-scan.persistence';

// Severity calibration end to end: the model's answer → validator (gate,
// downgrade, title guard) → dedupe (merge) → the PR's risk level. Fixture
// from a real MR (gpt-4o-mini, locale id): three MAJOR findings about UX
// feedback, two of them one root cause on nearby lines, titles hedged with
// "Potential" — shown as RISK · MEDIUM on a safe PR.

jest.mock('../../../generated/prisma/client', () => ({ Prisma: {} }));

type RawFinding = ReportReviewInput['findings'][number];

const FORM = 'src/Sewing/MachineList/MachineListForm/index.js';
const TABLE = 'src/Sewing/MachineList/MachineListTable/index.js';
const CONFIG = 'src/config/api.js';

function sent(...paths: string[]): Map<string, SentFile> {
  const added = new Set(Array.from({ length: 80 }, (_, i) => i + 1));
  const lines = new Map(
    [...added].map((n) => [n, `  const value${n} = compute(${n});`] as const),
  );
  return new Map(paths.map((path) => [path, { addedLines: added, lines }]));
}

function raw(overrides: Partial<RawFinding>): RawFinding {
  return {
    file: FORM,
    line_start: 24,
    line_end: 24,
    category: 'error_handling',
    severity: 'major',
    title: 'Potential missing feedback on invalid submit',
    message:
      'The form returns early on invalid input without telling the user why.',
    confidence: 0.8,
    ...overrides,
  };
}

// What the scan counts would be for these kept findings (all active here).
function riskOf(kept: { severity: FindingSeverity }[]) {
  return riskLevelFromCounts({
    criticalCount: kept.filter((f) => f.severity === FindingSeverity.CRITICAL)
      .length,
    majorCount: kept.filter((f) => f.severity === FindingSeverity.MAJOR).length,
  });
}

describe('AI post-processing (severity calibration)', () => {
  it('turns three hedged UX majors into two minors and a low risk', () => {
    const answer: RawFinding[] = [
      raw({}),
      // Same root cause, seven lines down, reworded.
      raw({
        line_start: 31,
        line_end: 31,
        title: 'Potential missing feedback on invalid submission',
        confidence: 0.75,
      }),
      raw({
        file: TABLE,
        line_start: 53,
        line_end: 53,
        title: 'Potential silent failure when the status update fails',
      }),
      // Would not be raised in a human review.
      raw({
        file: TABLE,
        line_start: 60,
        line_end: 60,
        title: 'Unclear label',
        confidence: 0.4,
      }),
    ];

    const validation = validateAiFindings(answer, sent(FORM, TABLE));
    const { kept, merged } = dedupeAiFindings(validation.accepted, []);

    expect(validation.droppedLowConfidence).toBe(1);
    expect(merged).toBe(1);
    expect(kept).toHaveLength(2);
    expect(kept.every((f) => f.severity === FindingSeverity.MINOR)).toBe(true);
    expect(
      kept.every((f) => f.reportedSeverity === FindingSeverity.MAJOR),
    ).toBe(true);
    expect(kept.find((f) => f.filePath === FORM)).toMatchObject({
      lineStart: 24,
      lineEnd: 31,
    });
    expect(riskOf(kept)).toBe('LOW');
  });

  it('leaves a confident, plainly titled secret critical and the risk high', () => {
    const validation = validateAiFindings(
      [
        raw({
          file: CONFIG,
          line_start: 3,
          line_end: 3,
          category: 'secret',
          severity: 'critical',
          title: 'Hardcoded API key in client config',
          message: 'A live API key is committed and shipped to every browser.',
          confidence: 0.95,
        }),
      ],
      sent(CONFIG),
    );
    const { kept } = dedupeAiFindings(validation.accepted, []);

    expect(kept).toHaveLength(1);
    expect(kept[0].severity).toBe(FindingSeverity.CRITICAL);
    expect(riskOf(kept)).toBe('HIGH');
  });
});
