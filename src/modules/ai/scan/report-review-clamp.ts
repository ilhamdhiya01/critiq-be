import { JsonSchema } from '../ai-provider.interface';
import { REPORT_REVIEW_SCHEMA } from './ai-prompt.constants';

// Models treat maxLength/maxItems as a suggestion: claude-sonnet-5 wrote a
// 1.7k-character summary against a 1500 limit, and the whole review — five
// valid findings — was rejected, retried and billed twice. Overlong text is
// trimmed here, before the schema check, so only the excess is lost. Types,
// enums and required fields are left alone: the schema still rejects those.

const ELLIPSIS = '…';
// A cut at a sentence or line end is preferred when it keeps at least this
// share of the allowed length; otherwise the last word boundary.
const SENTENCE_CUT_MIN_SHARE = 0.7;

type Schema = JsonSchema & {
  maxLength?: number;
  maxItems?: number;
  properties?: Record<string, Schema>;
  items?: Schema;
};

const schema = REPORT_REVIEW_SCHEMA as Schema;
const findingSchema = schema.properties!.findings.items!;
const LIMITS = {
  summary: schema.properties!.summary.maxLength!,
  findings: schema.properties!.findings.maxItems!,
  title: findingSchema.properties!.title.maxLength!,
  message: findingSchema.properties!.message.maxLength!,
};

// Shortens `text` to at most `max` characters, ending in "…". Deterministic,
// so a clamped title — part of an AI finding's fingerprint — is stable
// across runs.
export function truncateText(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  const room = max - ELLIPSIS.length;
  const head = text.slice(0, room);
  const sentenceEnd = Math.max(
    head.lastIndexOf('. '),
    head.lastIndexOf('.\n'),
    head.lastIndexOf('\n'),
  );
  let cut: string;
  if (sentenceEnd >= room * SENTENCE_CUT_MIN_SHARE) {
    // Keep the full stop, drop the newline/space after it.
    cut = head.slice(
      0,
      head[sentenceEnd] === '.' ? sentenceEnd + 1 : sentenceEnd,
    );
  } else {
    const space = head.search(/\s\S*$/);
    cut = space > 0 ? head.slice(0, space) : head;
  }
  return cut.trimEnd() + ELLIPSIS;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface ClampResult {
  value: unknown;
  // Paths of what was shortened (`summary`, `findings`, `findings[3].title`)
  // — for the log; never the text itself.
  clamped: string[];
}

export function clampReportReview(input: unknown): ClampResult {
  if (!isRecord(input)) {
    return { value: input, clamped: [] };
  }
  const clamped: string[] = [];
  const clampField = (
    target: Record<string, unknown>,
    key: 'summary' | 'title' | 'message',
    path: string,
  ) => {
    const text = target[key];
    if (typeof text === 'string' && text.length > LIMITS[key]) {
      target[key] = truncateText(text, LIMITS[key]);
      clamped.push(path);
    }
  };

  const value: Record<string, unknown> = { ...input };
  clampField(value, 'summary', 'summary');
  if (Array.isArray(value.findings)) {
    let findings: unknown[] = value.findings;
    if (findings.length > LIMITS.findings) {
      findings = findings.slice(0, LIMITS.findings);
      clamped.push('findings');
    }
    value.findings = findings.map((finding, index) => {
      if (!isRecord(finding)) {
        return finding;
      }
      const copy = { ...finding };
      clampField(copy, 'title', `findings[${index}].title`);
      clampField(copy, 'message', `findings[${index}].message`);
      return copy;
    });
  }
  return { value, clamped };
}
