// Line-level context helpers for rules that detect insecure *code/config*
// (not secrets). A line that merely mentions a construct — a comment, or
// prose inside a string such as a rule's own `message` — is not that
// construct being used. Secret rules deliberately do NOT use these: a
// credential inside a comment or a string is still a leaked credential.

import { findRegexLiteralSpans } from './regex-literal';

const COMMENT_PREFIXES = ['//', '/*', '*', '#'];

export function isCommentLine(text: string): boolean {
  const trimmed = text.trimStart();
  return COMMENT_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

// True when `index` falls inside a '...', "..." or `...` literal on this
// line. Single-line heuristic: a literal opened on a previous line (e.g. a
// multi-line template string) is not tracked.
export function isInsideStringLiteral(text: string, index: number): boolean {
  let openQuote: string | null = null;
  for (let i = 0; i < index; i++) {
    const char = text[i];
    if (openQuote !== null) {
      if (char === '\\') {
        i++;
      } else if (char === openQuote) {
        openQuote = null;
      }
    } else if (char === "'" || char === '"' || char === '`') {
      openQuote = char;
    }
  }
  return openQuote !== null;
}

// True when `pattern` matches somewhere on the line as actual code: the
// line is not a comment and at least one match starts outside a string.
export function matchesAsCode(pattern: RegExp, text: string): boolean {
  if (isCommentLine(text)) {
    return false;
  }
  const flags = pattern.flags.includes('g')
    ? pattern.flags
    : pattern.flags + 'g';
  const globalPattern = new RegExp(pattern.source, flags);
  for (const match of text.matchAll(globalPattern)) {
    if (!isInsideStringLiteral(text, match.index)) {
      return true;
    }
  }
  return false;
}

// Like matchesAsCode, but returns the first qualifying match's position, and
// keeps one more case: a match inside a string that is itself a regex
// argument (`new RegExp('…')`, `re.compile(r'…')`, `pattern: '…'`). Prose in a
// string is only a mention and is dropped here; a regex is a deliberate
// artefact, so it is handed on to the processor, which stores it suppressed
// as REGEX_LITERAL instead of silently losing it.
export function findCodeMatch(
  pattern: RegExp,
  text: string,
  language: string,
): { start: number; length: number } | null {
  if (isCommentLine(text)) {
    return null;
  }
  const flags = pattern.flags.includes('g')
    ? pattern.flags
    : pattern.flags + 'g';
  let regexSpans: [number, number][] | null = null;
  for (const match of text.matchAll(new RegExp(pattern.source, flags))) {
    const start = match.index;
    const length = match[0].length;
    if (!isInsideStringLiteral(text, start)) {
      return { start, length };
    }
    regexSpans ??= findRegexLiteralSpans(text, language);
    if (regexSpans.some(([s, e]) => start >= s && start + length <= e)) {
      return { start, length };
    }
  }
  return null;
}
