import {
  FindingCategory,
  FindingSeverity,
} from '../../../generated/prisma/enums';
import { SentFile } from './ai-prompt-builder';
import { ReportReviewInput } from './ai-prompt.constants';

// Per-finding checks on a report_review answer that already matched the
// schema. A finding that fails one is dropped (and counted as rejected) —
// the model pointed somewhere it was never shown, or said too little.

const MAX_RANGE = 40;
const MIN_MESSAGE_CHARS = 20;
// A title this long found verbatim in the code around the finding is the
// model reading the code's own words back (see echoesCode).
const ECHO_MIN_TITLE_CHARS = 12;
const ECHO_WINDOW_LINES = 5;
const CRITICAL_MIN_CONFIDENCE = 0.7;
const MAJOR_MIN_CONFIDENCE = 0.5;

export interface AiFindingDraft {
  filePath: string;
  lineStart: number;
  lineEnd: number;
  category: FindingCategory;
  severity: FindingSeverity;
  title: string;
  message: string;
  confidence: number;
}

export type RejectReason =
  | 'file_not_sent'
  | 'bad_range'
  | 'range_too_long'
  | 'outside_added_lines'
  | 'empty_title'
  | 'message_too_short'
  | 'echoes_code';

export interface ValidationResult {
  accepted: AiFindingDraft[];
  rejected: { file: string; reason: RejectReason }[];
}

function normalizePath(path: string): string {
  return path
    .trim()
    .replace(/\\/g, '/')
    .replace(/^(\.\/)+/, '');
}

// A line counts when it is an added line, or directly next to one — one line
// of slack at the edge of an added block, since models often point at the
// closing brace or the line just before the change.
function isReviewable(line: number, added: Set<number>): boolean {
  return added.has(line) || added.has(line - 1) || added.has(line + 1);
}

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// The finding's title appears word for word in the code it points at (±5
// lines): the model copied what the code says instead of finding a problem.
// gpt-4o-mini, reviewing Critiq's own rule definitions, reported
// `title: 'Hardcoded credential'` as a hardcoded credential, confidence 1.
// A real problem's title is not usually written out next to it.
function echoesCode(
  title: string,
  lines: Map<number, string>,
  lineStart: number,
  lineEnd: number,
): boolean {
  const needle = normalizeText(title);
  if (needle.length < ECHO_MIN_TITLE_CHARS) {
    return false;
  }
  const window: string[] = [];
  for (
    let line = lineStart - ECHO_WINDOW_LINES;
    line <= lineEnd + ECHO_WINDOW_LINES;
    line += 1
  ) {
    const text = lines.get(line);
    if (text !== undefined) {
      window.push(text);
    }
  }
  return ` ${normalizeText(window.join(' '))} `.includes(` ${needle} `);
}

// Below the confidence bar a finding drops one level rather than
// disappearing: an unsure critical is still worth a reviewer's look.
function severityFor(
  severity: 'critical' | 'major' | 'minor',
  confidence: number,
): FindingSeverity {
  if (severity === 'critical') {
    return confidence >= CRITICAL_MIN_CONFIDENCE
      ? FindingSeverity.CRITICAL
      : FindingSeverity.MAJOR;
  }
  if (severity === 'major') {
    return confidence >= MAJOR_MIN_CONFIDENCE
      ? FindingSeverity.MAJOR
      : FindingSeverity.MINOR;
  }
  return FindingSeverity.MINOR;
}

export function validateAiFindings(
  findings: ReportReviewInput['findings'],
  sentFiles: Map<string, SentFile>,
): ValidationResult {
  const result: ValidationResult = { accepted: [], rejected: [] };
  for (const finding of findings) {
    const filePath = normalizePath(finding.file);
    const reject = (reason: RejectReason) =>
      result.rejected.push({ file: filePath, reason });

    const sent = sentFiles.get(filePath);
    if (!sent) {
      reject('file_not_sent');
      continue;
    }
    if (finding.line_end < finding.line_start) {
      reject('bad_range');
      continue;
    }
    if (finding.line_end - finding.line_start > MAX_RANGE) {
      reject('range_too_long');
      continue;
    }
    let inside = true;
    for (let line = finding.line_start; line <= finding.line_end; line += 1) {
      if (!isReviewable(line, sent.addedLines)) {
        inside = false;
        break;
      }
    }
    if (!inside) {
      reject('outside_added_lines');
      continue;
    }
    const title = finding.title.trim();
    if (!title) {
      reject('empty_title');
      continue;
    }
    const message = finding.message.trim();
    if (message.length < MIN_MESSAGE_CHARS) {
      reject('message_too_short');
      continue;
    }
    if (echoesCode(title, sent.lines, finding.line_start, finding.line_end)) {
      reject('echoes_code');
      continue;
    }
    result.accepted.push({
      filePath,
      lineStart: finding.line_start,
      lineEnd: finding.line_end,
      category: finding.category.toUpperCase() as FindingCategory,
      severity: severityFor(finding.severity, finding.confidence),
      title,
      message,
      confidence: finding.confidence,
    });
  }
  return result;
}
