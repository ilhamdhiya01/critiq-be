import { matchesSchema } from '../ai-schema-validator';
import { REPORT_REVIEW_SCHEMA } from './ai-prompt.constants';
import { clampReportReview, truncateText } from './report-review-clamp';

function finding(overrides: Record<string, unknown> = {}) {
  return {
    file: 'src/a.ts',
    line_start: 3,
    line_end: 4,
    category: 'logic',
    severity: 'major',
    title: 'Off-by-one in pagination',
    message: 'The last page is skipped because the loop stops one early.',
    confidence: 0.8,
    ...overrides,
  };
}

function review(overrides: Record<string, unknown> = {}) {
  return {
    summary: 'Adds pagination.',
    risk_level: 'medium',
    findings: [finding()],
    ...overrides,
  };
}

// The shape claude-sonnet-5 sent: sentences of prose, 1.7k characters.
const LONG_SUMMARY = Array.from(
  { length: 30 },
  (_, i) => `Kalimat nomor ${i + 1} menjelaskan perubahan pada modul ini.`,
).join(' ');

describe('truncateText', () => {
  it('leaves text within the limit untouched', () => {
    expect(truncateText('short', 10)).toBe('short');
    expect(truncateText('exactly10!', 10)).toBe('exactly10!');
  });

  it('cuts at a sentence end when one is close to the limit', () => {
    const text = 'The first sentence is here. Then more words follow';
    expect(truncateText(text, 32)).toBe('The first sentence is here.…');
  });

  it('prefers a word boundary over a sentence end far from the limit', () => {
    const text = 'Short one. Then a much longer second sentence runs on';
    expect(truncateText(text, 40)).toBe(
      'Short one. Then a much longer second…',
    );
  });

  it('cuts at a word boundary otherwise', () => {
    const cut = truncateText('alpha beta gamma delta epsilon', 20);
    expect(cut).toBe('alpha beta gamma…');
    expect(cut.length).toBeLessThanOrEqual(20);
  });

  it('cuts hard when there is no boundary', () => {
    expect(truncateText('x'.repeat(50), 10)).toBe(`${'x'.repeat(9)}…`);
  });
});

describe('clampReportReview', () => {
  it('trims an overlong summary so the review passes the schema', () => {
    expect(LONG_SUMMARY.length).toBeGreaterThan(1500);
    const input = review({ summary: LONG_SUMMARY });
    expect(matchesSchema(REPORT_REVIEW_SCHEMA, input)).toBe(false);

    const { value, clamped } = clampReportReview(input);

    const summary = (value as { summary: string }).summary;
    expect(summary.length).toBeLessThanOrEqual(1500);
    expect(summary.endsWith('.…')).toBe(true);
    expect(clamped).toEqual(['summary']);
    expect(matchesSchema(REPORT_REVIEW_SCHEMA, value)).toBe(true);
  });

  it('trims titles and messages and names each field it touched', () => {
    const { value, clamped } = clampReportReview(
      review({
        findings: [
          finding(),
          finding({ title: 'word '.repeat(19), message: 'kata '.repeat(130) }),
        ],
      }),
    );
    const findings = (value as ReturnType<typeof review>).findings;
    expect(findings[0]).toEqual(finding());
    expect(findings[1].title.length).toBeLessThanOrEqual(80);
    expect(findings[1].message.length).toBeLessThanOrEqual(600);
    expect(clamped).toEqual(['findings[1].title', 'findings[1].message']);
    expect(matchesSchema(REPORT_REVIEW_SCHEMA, value)).toBe(true);
  });

  it('keeps the first 25 findings', () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      finding({ line_start: i + 1, line_end: i + 1 }),
    );
    const { value, clamped } = clampReportReview(review({ findings: many }));
    const findings = (value as ReturnType<typeof review>).findings;
    expect(findings).toHaveLength(25);
    expect(findings[24].line_start).toBe(25);
    expect(clamped).toEqual(['findings']);
  });

  it('leaves wrong types for the schema to reject', () => {
    const input = review({
      summary: 42,
      findings: [finding({ title: 7, severity: 'blocker' })],
    });
    const { value, clamped } = clampReportReview(input);
    expect(value).toEqual(input);
    expect(clamped).toEqual([]);
    expect(matchesSchema(REPORT_REVIEW_SCHEMA, value)).toBe(false);
  });

  it('passes non-objects through', () => {
    expect(clampReportReview(null)).toEqual({ value: null, clamped: [] });
    expect(clampReportReview('text')).toEqual({ value: 'text', clamped: [] });
    expect(clampReportReview([1])).toEqual({ value: [1], clamped: [] });
  });

  it('does not mutate its input and is deterministic', () => {
    const input = review({ summary: LONG_SUMMARY });
    const first = clampReportReview(input);
    const second = clampReportReview(input);
    expect(input.summary).toBe(LONG_SUMMARY);
    expect(first).toEqual(second);
  });
});
