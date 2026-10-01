import { JsonSchema } from '../ai-provider.interface';
import {
  REPORT_REVIEW_SCHEMA,
  REPORT_REVIEW_TOOL,
  RETRY_SYSTEM_SUFFIX,
} from './ai-prompt.constants';

// claude-sonnet-5 through an OpenAI-compatible gateway leaves out one
// required report_review field in about one answer in five (the gateway
// does not enforce `strict`) — risk_level one time, findings or summary
// another. Rejecting the whole answer lost every finding and paid twice.
// The schema sent to the model is unchanged; these only decide what Critiq
// accepts and how it asks again.

// risk_level is informational since the PR's risk is computed from its
// active findings: accepted when absent, still type-checked when present.
export const REPORT_REVIEW_VALIDATION_SCHEMA: JsonSchema = {
  ...REPORT_REVIEW_SCHEMA,
  required: (REPORT_REVIEW_SCHEMA.required as string[]).filter(
    (field) => field !== 'risk_level',
  ),
};

export type ReviewField = 'summary' | 'findings';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// The fields a retry must ask for again: absent, or not even the right type.
export function missingReviewFields(toolInput: unknown): ReviewField[] {
  if (!isRecord(toolInput)) {
    return ['summary', 'findings'];
  }
  const missing: ReviewField[] = [];
  if (typeof toolInput.summary !== 'string') {
    missing.push('summary');
  }
  if (!Array.isArray(toolInput.findings)) {
    missing.push('findings');
  }
  return missing;
}

// Named fields get a far better second answer than "not valid".
export function retrySuffixFor(missing: ReviewField[]): string {
  if (missing.length === 0) {
    return RETRY_SYSTEM_SUFFIX;
  }
  return `\n\nYour previous ${REPORT_REVIEW_TOOL} call omitted: ${missing.join(', ')}. Call the tool exactly once again with every required field — summary, risk_level, findings (use [] when there is nothing to report).`;
}

export interface SalvagedReview {
  value: Record<string, unknown>;
  // Fields no attempt provided, filled with an empty value.
  defaulted: ReviewField[];
}

// After the retry still left a field out: the last answer, with a missing
// summary/findings taken from the earlier attempt when it had one, and an
// empty value otherwise. Wrong types elsewhere are left for the schema to
// reject — this only fills what is absent.
export function salvageReview(attempts: unknown[]): SalvagedReview | null {
  const records = attempts.filter(isRecord);
  const base = records.at(-1);
  if (!base) {
    return null;
  }
  const value: Record<string, unknown> = { ...base };
  const defaulted: ReviewField[] = [];
  const fill = (
    field: ReviewField,
    valid: (v: unknown) => boolean,
    empty: unknown,
  ) => {
    if (valid(value[field])) {
      return;
    }
    const earlier = records.find((record) => valid(record[field]));
    if (earlier) {
      value[field] = earlier[field];
    } else {
      value[field] = empty;
      defaulted.push(field);
    }
  };
  fill('summary', (v) => typeof v === 'string', '');
  fill('findings', Array.isArray, []);
  return { value, defaulted };
}
