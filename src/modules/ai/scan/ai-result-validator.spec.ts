import { FindingSeverity } from '../../../generated/prisma/enums';
import { SentFile } from './ai-prompt-builder';
import { ReportReviewInput } from './ai-prompt.constants';
import { validateAiFindings } from './ai-result-validator';

type RawFinding = ReportReviewInput['findings'][number];

// Added lines 10–20 and 100–120 of src/session.ts.
const SENT = new Map<string, SentFile>([
  [
    'src/session.ts',
    {
      addedLines: new Set([
        ...Array.from({ length: 11 }, (_, i) => 10 + i),
        ...Array.from({ length: 21 }, (_, i) => 100 + i),
      ]),
      lines: new Map([
        [110, '  await refreshSession(token);'],
        // A rule definition: describes a problem, is not one.
        [114, 'export const secretAssignmentLiteralRule: Rule = {'],
        [115, "  title: 'Hardcoded credential',"],
        [116, '  message:'],
        [
          117,
          "    'This assigns what looks like a real credential as a literal value.',",
        ],
      ]),
    },
  ],
]);

function finding(overrides: Partial<RawFinding> = {}): RawFinding {
  return {
    file: 'src/session.ts',
    line_start: 110,
    line_end: 110,
    category: 'error_handling',
    severity: 'critical',
    title: 'Unhandled rejection',
    message: 'The promise rejection is not handled and will crash the worker.',
    confidence: 0.9,
    ...overrides,
  };
}

describe('validateAiFindings', () => {
  it('accepts a finding on added lines', () => {
    const { accepted } = validateAiFindings([finding()], SENT);
    expect(accepted).toHaveLength(1);
    expect(accepted[0].severity).toBe(FindingSeverity.CRITICAL);
    expect(accepted[0].category).toBe('ERROR_HANDLING');
  });

  // Acceptance 6.
  it.each([
    [340, 340, 'outside_added_lines'],
    [123, 123, 'outside_added_lines'], // 3 lines past the hunk edge
    [97, 97, 'outside_added_lines'],
  ])('rejects %i-%i (%s)', (start, end, reason) => {
    const { rejected } = validateAiFindings(
      [finding({ line_start: start, line_end: end })],
      SENT,
    );
    expect(rejected).toEqual([{ file: 'src/session.ts', reason }]);
  });

  it.each([121, 99, 21, 9])(
    'accepts line %i, one line off an added block',
    (line) => {
      const { accepted } = validateAiFindings(
        [finding({ line_start: line, line_end: line })],
        SENT,
      );
      expect(accepted).toHaveLength(1);
    },
  );

  it.each([
    [{ file: 'src/other.ts' }, 'file_not_sent'],
    [{ line_start: 12, line_end: 10 }, 'bad_range'],
    [{ line_start: 10, line_end: 120 }, 'range_too_long'],
    [{ title: '   ' }, 'empty_title'],
    [{ message: 'Too short.' }, 'message_too_short'],
  ])('rejects %j as %s', (overrides, reason) => {
    const { rejected } = validateAiFindings([finding(overrides)], SENT);
    expect(rejected[0].reason).toBe(reason);
  });

  it('normalizes ./ and backslashes in paths', () => {
    const { accepted } = validateAiFindings(
      [finding({ file: '.\\src\\session.ts'.replace('.\\', './') })],
      SENT,
    );
    expect(accepted[0].filePath).toBe('src/session.ts');
  });

  // Severity calibration: below 0.7 one level down; below 0.5 not stored.
  it.each([
    ['critical', 0.55, FindingSeverity.MAJOR],
    ['critical', 0.7, FindingSeverity.CRITICAL],
    ['major', 0.69, FindingSeverity.MINOR],
    ['major', 0.7, FindingSeverity.MAJOR],
    ['minor', 0.5, FindingSeverity.MINOR],
  ] as const)('%s at confidence %f → %s', (severity, confidence, expected) => {
    const { accepted } = validateAiFindings(
      [finding({ severity, confidence })],
      SENT,
    );
    expect(accepted[0].severity).toBe(expected);
  });

  it('drops a finding below 0.5 confidence, counting it apart from rejects', () => {
    const result = validateAiFindings(
      [finding({ confidence: 0.49 }), finding({ confidence: 0.1 })],
      SENT,
    );
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected).toHaveLength(0);
    expect(result.droppedLowConfidence).toBe(2);
  });

  // "Potential …" is the model guessing: one level down, not dropped — and
  // on top of a confidence downgrade.
  it.each([
    ['Potential race on the session cache', 'critical', 0.9, 'MAJOR'],
    ['May leak the refresh token', 'critical', 0.6, 'MINOR'],
    ['possible null dereference', 'major', 0.8, 'MINOR'],
    ['Maybe-typed response is never checked', 'major', 0.8, 'MAJOR'],
  ] as const)('"%s" (%s, %f) → %s', (title, severity, confidence, expected) => {
    const { accepted } = validateAiFindings(
      [finding({ title, severity, confidence })],
      SENT,
    );
    expect(accepted[0].severity).toBe(FindingSeverity[expected]);
  });

  it('keeps the severity the model reported', () => {
    const { accepted } = validateAiFindings(
      [finding({ severity: 'critical', confidence: 0.6 })],
      SENT,
    );
    expect(accepted[0]).toMatchObject({
      severity: FindingSeverity.MAJOR,
      reportedSeverity: FindingSeverity.CRITICAL,
    });
  });

  // gpt-4o-mini on critiq-be PR #7: rule definitions reported as secrets.
  it('rejects a finding whose title is copied from the code it points at', () => {
    const { accepted, rejected } = validateAiFindings(
      [
        finding({
          line_start: 117,
          line_end: 117,
          category: 'secret',
          title: 'Hardcoded credential',
          message:
            'A credential that looks real is assigned as a literal value.',
        }),
      ],
      SENT,
    );
    expect(accepted).toHaveLength(0);
    expect(rejected).toEqual([
      { file: 'src/session.ts', reason: 'echoes_code' },
    ]);
  });

  it('keeps a finding whose title only shares words with the code', () => {
    const { accepted } = validateAiFindings(
      [
        finding({
          line_start: 110,
          line_end: 110,
          title: 'Session refresh rejection is never handled',
        }),
      ],
      SENT,
    );
    expect(accepted).toHaveLength(1);
  });

  it('does not treat a short title as an echo', () => {
    const { accepted } = validateAiFindings(
      [finding({ line_start: 115, line_end: 115, title: 'Hardcoded' })],
      SENT,
    );
    expect(accepted).toHaveLength(1);
  });
});
