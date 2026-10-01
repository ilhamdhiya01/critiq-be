import { matchesSchema } from '../ai-schema-validator';
import { RETRY_SYSTEM_SUFFIX } from './ai-prompt.constants';
import {
  missingReviewFields,
  REPORT_REVIEW_VALIDATION_SCHEMA,
  retrySuffixFor,
  salvageReview,
} from './report-review-repair';

const FINDING = {
  file: 'src/a.ts',
  line_start: 3,
  line_end: 3,
  category: 'logic',
  severity: 'major',
  title: 'Inverted guard skips the save',
  message: 'The condition is inverted, so valid input is never saved.',
  confidence: 0.8,
};

const valid = (value: unknown) =>
  matchesSchema(REPORT_REVIEW_VALIDATION_SCHEMA, value);

describe('REPORT_REVIEW_VALIDATION_SCHEMA', () => {
  // Diagnosis run 3 of 5: summary + findings, no risk_level.
  it('accepts an answer without risk_level', () => {
    expect(valid({ summary: 's', findings: [FINDING] })).toBe(true);
  });

  it('still checks risk_level when present, and the other fields', () => {
    expect(valid({ summary: 's', risk_level: 'severe', findings: [] })).toBe(
      false,
    );
    expect(valid({ risk_level: 'low', findings: [] })).toBe(false);
    expect(valid({ summary: 's', risk_level: 'low' })).toBe(false);
  });
});

describe('missingReviewFields / retrySuffixFor', () => {
  it.each([
    [{ summary: 's', risk_level: 'high' }, ['findings']],
    [{ findings: [] }, ['summary']],
    [{ risk_level: 'low' }, ['summary', 'findings']],
    [{ summary: 's', findings: 'none' }, ['findings']],
    [null, ['summary', 'findings']],
    [{ summary: 's', findings: [] }, []],
  ])('%j → %j', (input, missing) => {
    expect(missingReviewFields(input)).toEqual(missing);
  });

  it('names the missing fields, and falls back to the generic retry', () => {
    expect(retrySuffixFor(['findings'])).toContain(
      'omitted: findings. Call the tool exactly once again',
    );
    expect(retrySuffixFor(['findings'])).toContain('use [] when');
    expect(retrySuffixFor([])).toBe(RETRY_SYSTEM_SUFFIX);
  });
});

describe('salvageReview', () => {
  it('fills a field from the earlier attempt when the retry dropped it', () => {
    const salvaged = salvageReview([
      { summary: 'from the first', findings: [FINDING] },
      { summary: 'from the retry', risk_level: 'medium' },
    ]);
    expect(salvaged).toEqual({
      value: {
        summary: 'from the retry',
        risk_level: 'medium',
        findings: [FINDING],
      },
      defaulted: [],
    });
    expect(valid(salvaged!.value)).toBe(true);
  });

  it('empties what no attempt had, and says so', () => {
    const salvaged = salvageReview([
      { summary: 'a' },
      { summary: 'b', risk_level: 'low' },
    ]);
    expect(salvaged?.value).toMatchObject({ summary: 'b', findings: [] });
    expect(salvaged?.defaulted).toEqual(['findings']);
  });

  it('leaves wrong types for the schema to reject', () => {
    const salvaged = salvageReview([
      { summary: 's', findings: [{ ...FINDING, severity: 'blocker' }] },
    ]);
    expect(valid(salvaged!.value)).toBe(false);
  });

  it('gives up without an object answer', () => {
    expect(salvageReview([null, 'text'])).toBeNull();
  });
});
