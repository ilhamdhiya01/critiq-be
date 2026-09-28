// Where the comments are on one added line, so a match inside one can be
// stored as suppressed (COMMENT) rather than counted — v1.5.0 delta 2.
//
// One left-to-right pass tracking quote state, so `"http://x"` and
// `color: '#fff'` are strings, not comments. Block comments jump straight to
// their closer with indexOf, which keeps the whole pass linear on a 1 MB
// minified line. Deliberately line-local: a block comment opened on a line
// before the diff's first `+` line is invisible here (the scan only sees
// added lines) — a known limitation, listed in CLAUDE.md.

import type { Span } from './regex-literal';

export interface CommentSyntax {
  // Line-comment markers, e.g. `//`, `--`.
  line: string[];
  // Block comments that may open and close on the same line.
  block: [open: string, close: string][];
  // `#` line comments. 'anywhere' (Python, Ruby): any `#` outside a string.
  // 'after-space' (shell, YAML, .env, TOML, INI, Dockerfile, Makefile): only
  // at line start or after whitespace — in those formats `PASSWORD=abc#123`
  // is a value containing `#`, and treating it as a comment would hide a
  // real credential.
  hash: 'anywhere' | 'after-space' | null;
  // Python docstring opened at the start of this line.
  docstring: boolean;
  // Whether quotes open strings. Off for markup, where an apostrophe in text
  // (`don't`) would otherwise swallow the rest of the line.
  quotes: boolean;
}

const SLASH: CommentSyntax = {
  line: ['//'],
  block: [['/*', '*/']],
  hash: null,
  docstring: false,
  quotes: true,
};
const HASH_ANYWHERE: CommentSyntax = {
  line: [],
  block: [],
  hash: 'anywhere',
  docstring: false,
  quotes: true,
};
const PYTHON: CommentSyntax = { ...HASH_ANYWHERE, docstring: true };
const HASH_AFTER_SPACE: CommentSyntax = {
  ...HASH_ANYWHERE,
  hash: 'after-space',
};
const SQL: CommentSyntax = {
  line: ['--'],
  block: [['/*', '*/']],
  hash: null,
  docstring: false,
  quotes: true,
};
const DASH: CommentSyntax = { ...SQL, block: [] };
const MARKUP: CommentSyntax = {
  line: [],
  block: [['<!--', '-->']],
  hash: null,
  docstring: false,
  quotes: false,
};
const CSS: CommentSyntax = {
  line: [],
  block: [['/*', '*/']],
  hash: null,
  docstring: false,
  quotes: true,
};

const BY_EXTENSION: Record<string, CommentSyntax> = {};
function register(syntax: CommentSyntax, extensions: string[]): void {
  for (const extension of extensions) {
    BY_EXTENSION[extension] = syntax;
  }
}
register(SLASH, [
  'js', 'ts', 'jsx', 'tsx', 'mjs', 'cjs', 'go', 'java', 'kt', 'php', 'c',
  'h', 'cpp', 'cc', 'hpp', 'cs', 'swift', 'rs', 'scss',
]); // prettier-ignore
register(PYTHON, ['py']);
register(HASH_ANYWHERE, ['rb', 'r', 'pl']);
register(HASH_AFTER_SPACE, [
  'sh', 'bash', 'zsh', 'yaml', 'yml', 'toml', 'env', 'ini', 'cfg', 'conf',
]); // prettier-ignore
register(SQL, ['sql']);
register(DASH, ['lua', 'hs']);
register(MARKUP, ['html', 'htm', 'xml', 'vue', 'svelte', 'md']);
register(CSS, ['css']);

// null = no known comment syntax; nothing on the line counts as a comment.
export function commentSyntaxFor(filePath: string): CommentSyntax | null {
  const basename = (filePath.split('/').pop() ?? filePath).toLowerCase();
  if (
    basename.startsWith('dockerfile') ||
    basename === 'makefile' ||
    basename === '.env' ||
    basename.startsWith('.env.')
  ) {
    return HASH_AFTER_SPACE;
  }
  const extension = basename.includes('.') ? basename.split('.').pop()! : '';
  return BY_EXTENSION[extension] ?? null;
}

function isWhitespaceCode(code: number): boolean {
  return code === 32 || (code >= 9 && code <= 13);
}

function startsWithAt(line: string, i: number, marker: string): boolean {
  return line.startsWith(marker, i);
}

// Every comment span on the line, in order. A line comment, or a block
// comment with no closer on this line, runs to end of line and ends the scan.
export function findCommentSpans(line: string, syntax: CommentSyntax): Span[] {
  const spans: Span[] = [];
  let quote = 0; // char code of the open quote, 0 when outside a string
  let i = 0;

  if (syntax.docstring) {
    let first = 0;
    while (first < line.length && isWhitespaceCode(line.charCodeAt(first))) {
      first += 1;
    }
    const opener = line.startsWith('"""', first)
      ? '"""'
      : line.startsWith("'''", first)
        ? "'''"
        : null;
    if (opener) {
      const close = line.indexOf(opener, first + 3);
      const end = close >= 0 ? close + 3 : line.length;
      spans.push([first, end]);
      i = end;
    }
  }

  while (i < line.length) {
    const code = line.charCodeAt(i);

    if (quote !== 0) {
      if (code === 92) {
        // backslash escapes the next character
        i += 2;
        continue;
      }
      if (code === quote) {
        quote = 0;
      }
      i += 1;
      continue;
    }

    if (syntax.quotes && (code === 34 || code === 39 || code === 96)) {
      quote = code;
      i += 1;
      continue;
    }

    let blockHandled = false;
    for (const [open, close] of syntax.block) {
      if (startsWithAt(line, i, open)) {
        const closeAt = line.indexOf(close, i + open.length);
        if (closeAt < 0) {
          spans.push([i, line.length]);
          return spans;
        }
        spans.push([i, closeAt + close.length]);
        i = closeAt + close.length;
        blockHandled = true;
        break;
      }
    }
    if (blockHandled) {
      continue;
    }

    for (const marker of syntax.line) {
      if (startsWithAt(line, i, marker)) {
        spans.push([i, line.length]);
        return spans;
      }
    }

    if (
      code === 35 && // '#'
      (syntax.hash === 'anywhere' ||
        (syntax.hash === 'after-space' &&
          (i === 0 || isWhitespaceCode(line.charCodeAt(i - 1)))))
    ) {
      spans.push([i, line.length]);
      return spans;
    }

    i += 1;
  }
  return spans;
}

// Start of the comment that runs to end of line, or -1 — the shape the
// delta-2 prompt specifies. Block comments closed mid-line are only visible
// through findCommentSpans / isInsideComment.
export function commentSpanStart(line: string, syntax: CommentSyntax): number {
  const spans = findCommentSpans(line, syntax);
  const last = spans[spans.length - 1];
  return last && last[1] === line.length ? last[0] : -1;
}

// True when the match starts inside a comment on this line.
export function isInsideComment(
  line: string,
  matchStart: number,
  filePath: string,
): boolean {
  const syntax = commentSyntaxFor(filePath);
  if (!syntax) {
    return false;
  }
  return findCommentSpans(line, syntax).some(
    ([start, end]) => matchStart >= start && matchStart < end,
  );
}
