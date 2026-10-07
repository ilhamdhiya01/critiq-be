import { parse, ParserPlugin } from '@babel/parser';
import { createHash } from 'crypto';
import { DiffHunk, parsePatch } from '../../diff/diff-parser';

// A change that leaves a file unparseable — a closing brace commented out,
// a bracket deleted. Line rules cannot see it: `// }` is a fine line on its
// own, and a syntax error is a property of the whole file. So this check
// reads the changed file at head (contents API) and parses it — a
// deliberate exception to "only `+` lines": the whole file is read, but only
// files the diff touched, and only an error the change introduced is
// reported (the same file before the change must parse).
export const SYNTAX_RULE_ID = 'code.syntax_error';

export type SyntaxKind = 'js' | 'ts' | 'tsx' | 'json';

const KIND_BY_EXTENSION: Record<string, SyntaxKind> = {
  js: 'js',
  jsx: 'js',
  mjs: 'js',
  cjs: 'js',
  ts: 'ts',
  mts: 'ts',
  cts: 'ts',
  tsx: 'tsx',
  json: 'json',
};

// JSON with comments / trailing commas, read by tools that allow them —
// JSON.parse would call every one of them broken.
const JSONC_FILE =
  /(^|\/)(tsconfig[^/]*|jsconfig[^/]*|\.eslintrc|devcontainer|\.babelrc|\.swcrc)\.json$/i;
const JSONC_DIR = /(^|\/)\.vscode\//i;

const MAX_MESSAGE_CHARS = 200;
const MAX_SNIPPET_CHARS = 200;

// Babel's way of saying "valid syntax, just not enabled" (decorators, Flow,
// proposals) — the parser's limit, not a broken file.
const UNSUPPORTED_REASONS = new Set(['MissingPlugin', 'MissingOneOfPlugins']);

export function syntaxKindOf(filePath: string): SyntaxKind | null {
  const basename = filePath.split('/').pop() ?? filePath;
  const extension = basename.includes('.')
    ? basename.split('.').pop()!.toLowerCase()
    : '';
  const kind = KIND_BY_EXTENSION[extension] ?? null;
  if (
    kind === 'json' &&
    (JSONC_FILE.test(filePath) || JSONC_DIR.test(filePath))
  ) {
    return null;
  }
  return kind;
}

interface ParseFailure {
  line: number;
  message: string;
  // The parser lacks the syntax (a plugin), or gave up for its own reasons
  // (stack depth) — never reported.
  unsupported: boolean;
}

function pluginsFor(kind: Exclude<SyntaxKind, 'json'>): ParserPlugin[] {
  // decorators-legacy: Nest/Angular/MobX code is full of them.
  if (kind === 'ts') {
    return ['typescript', 'decorators-legacy'];
  }
  if (kind === 'tsx') {
    return ['typescript', 'jsx', 'decorators-legacy'];
  }
  return ['jsx', 'decorators-legacy'];
}

function jsParseFailure(
  content: string,
  kind: Exclude<SyntaxKind, 'json'>,
): ParseFailure | null {
  try {
    parse(content, {
      sourceType: 'unambiguous',
      // Snippets, scripts and module fragments are all fine files.
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
      allowImportExportEverywhere: true,
      allowSuperOutsideMethod: true,
      allowUndeclaredExports: true,
      plugins: pluginsFor(kind),
    });
    return null;
  } catch (error) {
    const e = error as {
      loc?: { line?: unknown };
      reasonCode?: unknown;
      message?: unknown;
    };
    if (typeof e.loc?.line !== 'number') {
      // Not a parse error with a position (e.g. a RangeError on absurdly
      // deep nesting): nothing trustworthy to report.
      return { line: 1, message: '', unsupported: true };
    }
    return {
      line: e.loc.line,
      // Babel appends "(line:column)"; the line is reported separately.
      message:
        typeof e.message === 'string'
          ? e.message.replace(/\s*\(\d+:\d+\)$/, '')
          : 'Syntax error',
      unsupported:
        typeof e.reasonCode === 'string' &&
        UNSUPPORTED_REASONS.has(e.reasonCode),
    };
  }
}

function jsonParseFailure(content: string): ParseFailure | null {
  const text = content.replace(/^\uFEFF/, '');
  if (text.trim() === '') {
    return null;
  }
  try {
    JSON.parse(text);
    return null;
  } catch (error) {
    // V8's message quotes the text around the error — which in a JSON file
    // can be a credential. Only the position is kept.
    const message = error instanceof Error ? error.message : '';
    const line = /line (\d+)/.exec(message);
    const position = /position (\d+)/.exec(message);
    return {
      line: line
        ? Number(line[1])
        : position
          ? text.slice(0, Number(position[1])).split('\n').length
          : 1,
      message: 'Invalid JSON',
      unsupported: false,
    };
  }
}

export function parseFailure(
  content: string,
  kind: SyntaxKind,
): ParseFailure | null {
  return kind === 'json'
    ? jsonParseFailure(content)
    : jsParseFailure(content, kind);
}

function reverseApply(headLines: string[], hunks: DiffHunk[]): string[] | null {
  const old: string[] = [];
  // Next head line (1-based) not yet copied.
  let cursor = 1;
  for (const hunk of hunks) {
    const keepsNewLines = hunk.lines.some((line) => line.type !== 'del');
    // A deletion-only hunk's newStart is the line the deletion follows.
    const firstNew = keepsNewLines ? hunk.newStart : hunk.newStart + 1;
    if (firstNew < cursor || firstNew - 1 > headLines.length) {
      return null;
    }
    for (; cursor < firstNew; cursor += 1) {
      old.push(headLines[cursor - 1]);
    }
    for (const line of hunk.lines) {
      if (line.type === 'del') {
        old.push(line.text);
        continue;
      }
      // Context and added lines are in head as-is — or the patch is not
      // the one head was built from, and nothing below can be trusted.
      if (headLines[cursor - 1] !== line.text) {
        return null;
      }
      if (line.type === 'context') {
        old.push(line.text);
      }
      cursor += 1;
    }
  }
  return [...old, ...headLines.slice(cursor - 1)];
}

// The file before the change, rebuilt from head and the patch (added lines
// out, removed lines back) — no second fetch, and the exact base of the
// diff this scan reads, FULL or INCREMENTAL. null when the patch does not
// fit head.
export function reconstructBase(
  head: string,
  hunks: DiffHunk[],
): string | null {
  const headLines = head.split('\n');
  const rebuilt = reverseApply(headLines, hunks);
  if (rebuilt) {
    return rebuilt.join('\n');
  }
  // A patch ending in "\n" leaves one empty, prefix-less line that the
  // diff parser keeps as context; it is not part of the file.
  const last = hunks.at(-1)?.lines.at(-1);
  if (last?.type === 'context' && last.text === '') {
    const trimmed = hunks.map((hunk, index) =>
      index === hunks.length - 1
        ? { ...hunk, lines: hunk.lines.slice(0, -1) }
        : hunk,
    );
    return reverseApply(headLines, trimmed)?.join('\n') ?? null;
  }
  return null;
}

// Head lines this change touched: every added line, and for a run of
// removed lines the line now standing where they were.
function changedLines(hunks: DiffHunk[]): number[] {
  const lines: number[] = [];
  for (const hunk of hunks) {
    let lastNewLine = hunk.newStart - 1;
    let pendingDeletion = false;
    for (const line of hunk.lines) {
      if (line.type === 'del') {
        pendingDeletion = true;
        continue;
      }
      if (pendingDeletion || line.type === 'add') {
        lines.push(line.newLine ?? lastNewLine + 1);
      }
      pendingDeletion = false;
      lastNewLine = line.newLine ?? lastNewLine + 1;
    }
    if (pendingDeletion) {
      lines.push(Math.max(1, lastNewLine));
    }
  }
  return [...new Set(lines)].sort((a, b) => a - b);
}

// The parser often stops far below the cause — at end of file for a missing
// `}`. The finding goes on the error line when the change touched it,
// otherwise on the last touched line above it (the commented-out brace),
// otherwise on the first touched line.
function locate(errorLine: number, touched: number[]): number | null {
  if (touched.length === 0) {
    return null;
  }
  if (touched.includes(errorLine)) {
    return errorLine;
  }
  const above = touched.filter((line) => line < errorLine);
  return above.length > 0 ? above[above.length - 1] : touched[0];
}

export interface SyntaxCheckInput {
  path: string;
  status: 'added' | 'removed' | 'modified' | 'renamed';
  patch: string;
  head: string;
  // Incremental scan of a file already holding a syntax finding: the error
  // predates this push, so "the file before must parse" would hide it and
  // wrongly resolve the finding. Off for those files only.
  skipBaseCheck?: boolean;
}

export interface SyntaxHit {
  ruleId: string;
  title: string;
  message: string;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  snippet: string | null;
  fingerprint: string;
}

export type SyntaxSkip =
  | 'unsupported_file'
  | 'parses'
  | 'unsupported_syntax'
  | 'base_unknown'
  | 'base_broken'
  | 'no_change';

export type SyntaxCheckResult = { hit: SyntaxHit } | { skipped: SyntaxSkip };

export function checkSyntax(input: SyntaxCheckInput): SyntaxCheckResult {
  const kind = syntaxKindOf(input.path);
  if (!kind) {
    return { skipped: 'unsupported_file' };
  }
  const failure = parseFailure(input.head, kind);
  if (!failure) {
    return { skipped: 'parses' };
  }
  if (failure.unsupported) {
    return { skipped: 'unsupported_syntax' };
  }
  const hunks = parsePatch(input.patch);
  // Only an error this change introduced: the file before it must parse.
  // An added file has no before — the plugin filter above is its guard.
  if (input.status !== 'added' && !input.skipBaseCheck) {
    const base = reconstructBase(input.head, hunks);
    if (base === null) {
      return { skipped: 'base_unknown' };
    }
    if (parseFailure(base, kind)) {
      return { skipped: 'base_broken' };
    }
  }
  const line = locate(failure.line, changedLines(hunks));
  if (line === null) {
    return { skipped: 'no_change' };
  }
  const lineText = input.head.split('\n')[line - 1] ?? '';
  return {
    hit: {
      ruleId: SYNTAX_RULE_ID,
      title: 'Syntax error',
      message:
        `This change leaves the file unparseable: ${failure.message.slice(0, MAX_MESSAGE_CHARS)}` +
        (failure.line === line
          ? '.'
          : ` (the parser stopped at line ${failure.line}).`),
      filePath: input.path,
      lineStart: line,
      lineEnd: line,
      snippet: lineText.trim().slice(0, MAX_SNIPPET_CHARS) || null,
      // One finding per file, independent of the line: a fix elsewhere in
      // the file closes it, a still-broken file persists it.
      fingerprint: createHash('sha1')
        .update(`${SYNTAX_RULE_ID}\0${input.path}`)
        .digest('hex'),
    },
  };
}
