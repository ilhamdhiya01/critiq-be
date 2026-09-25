// Line-level context helpers for rules that detect insecure *code/config*
// (not secrets). A line that merely mentions a construct — a comment, or
// prose inside a string such as a rule's own `message` — is not that
// construct being used. Secret rules deliberately do NOT use these: a
// credential inside a comment or a string is still a leaked credential.

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
