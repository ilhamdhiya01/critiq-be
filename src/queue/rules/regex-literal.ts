// Detects whether a rule match sits inside a *regex literal* — the pattern a
// linter, Semgrep rule or security tool uses to look FOR a secret or an
// insecure option, rather than the secret/option itself. Such matches are
// stored as suppressed (REGEX_LITERAL), not counted.
//
// One left-to-right pass over the line; the only regexes used are short
// sticky (`y`) probes anchored at token starts, so the cost stays linear even
// on a pathological 1 MB line (this runs inside the scan job, per match).
// Deliberately line-local: a regex literal that spans lines is not tracked.

export type Span = [start: number, end: number]; // [start, end)

const REGEX_METACHARS = new Set('\\^$.*+?()[]{}|');
const MIN_JS_REGEX_BODY = 8;

// Characters after which a `/` starts a regex literal rather than a division.
// After an identifier, number or `)`/`]`, a `/` is a division operator.
const REGEX_ALLOWED_AFTER = new Set('(,=:[!&|?{};+-*%<>~^');

const JS_CALL_OPENERS = [/new\s+RegExp\s*\(\s*/y];
const PY_CALL_OPENERS = [
  /re\.(?:compile|search|match|fullmatch|findall|finditer|sub|split)\s*\(\s*/y,
];
const GO_CALL_OPENERS = [/regexp\.(?:MustCompile|Compile)(?:POSIX)?\s*\(\s*/y];
const PROPERTY_OPENER = /["']?(?:pattern|regex|regexp|matcher)["']?\s*:\s*/iy;

// charCode checks instead of per-character regex tests: this loop touches
// every character of the line.
function isIdentifierCode(code: number): boolean {
  return (
    (code >= 97 && code <= 122) || // a-z
    (code >= 65 && code <= 90) || // A-Z
    (code >= 48 && code <= 57) || // 0-9
    code === 95 || // _
    code === 36 // $
  );
}

function isWhitespaceCode(code: number): boolean {
  return code === 32 || (code >= 9 && code <= 13);
}

// First characters the openers can start with, so the sticky probes only run
// at tokens that could possibly match.
const CALL_OPENER_FIRST = new Set('nrR');
const PROPERTY_OPENER_FIRST = new Set('"\'pPrRmM');

function callOpenersFor(language: string): RegExp[] {
  switch (language) {
    case 'js':
      return JS_CALL_OPENERS;
    case 'py':
      return PY_CALL_OPENERS;
    case 'go':
      return GO_CALL_OPENERS;
    default:
      return [];
  }
}

function lineCommentStart(line: string, i: number, language: string): boolean {
  if (language === 'js' || language === 'go') {
    return line[i] === '/' && line[i + 1] === '/';
  }
  if (language === 'py' || language === '*') {
    return line[i] === '#';
  }
  return false;
}

// Index just past a quoted string starting at `i` (line[i] is the quote).
// Unterminated strings run to end of line.
function readString(line: string, i: number): number {
  const quote = line[i];
  let j = i + 1;
  while (j < line.length) {
    if (line[j] === '\\') {
      j += 2;
      continue;
    }
    if (line[j] === quote) {
      return j + 1;
    }
    j += 1;
  }
  return line.length;
}

// For a `/` at `i`, the end (exclusive, flags included) of a JS regex literal,
// or -1 when it does not close on this line.
//
// A -1 means the scan already walked to end of line. Callers must then stop
// trying regex literals on this line (ScanState.jsRegexExhausted): otherwise
// a line like `=/[=/[=/[…` rescans the tail at every `/` — quadratic, minutes
// on a 1 MB minified line. Giving up can only miss a suppression, never
// invent one.
function readJsRegexLiteral(line: string, i: number): number {
  let j = i + 1;
  let inClass = false;
  while (j < line.length) {
    const char = line[j];
    if (char === '\\') {
      j += 2;
      continue;
    }
    if (char === '[') {
      inClass = true;
    } else if (char === ']') {
      inClass = false;
    } else if (char === '/' && !inClass) {
      let k = j + 1;
      while (k < line.length && /[dgimsuvy]/.test(line[k])) {
        k += 1;
      }
      return k;
    }
    j += 1;
  }
  return -1;
}

function qualifiesAsRegexBody(body: string): boolean {
  if (body.length < MIN_JS_REGEX_BODY) {
    return false;
  }
  for (const char of body) {
    if (REGEX_METACHARS.has(char)) {
      return true;
    }
  }
  return false;
}

// Python string prefixes (r, b, rb, br, u, f…) directly before a quote.
function pythonStringStart(line: string, i: number): number {
  let j = i;
  while (j < line.length && j - i < 2 && /[rRbBuUfF]/.test(line[j])) {
    j += 1;
  }
  return line[j] === '"' || line[j] === "'" ? j : -1;
}

interface ScanState {
  jsRegexExhausted: boolean;
}

function readJsRegexOnce(line: string, i: number, state: ScanState): number {
  if (state.jsRegexExhausted) {
    return -1;
  }
  const end = readJsRegexLiteral(line, i);
  if (end < 0) {
    state.jsRegexExhausted = true;
  }
  return end;
}

function probe(pattern: RegExp, line: string, i: number): number {
  pattern.lastIndex = i;
  const match = pattern.exec(line);
  return match ? i + match[0].length : -1;
}

// The span of the argument/value that starts at `i` (after an opener), or
// null when it is not a literal. `allowBare` covers unquoted YAML values.
function literalAt(
  line: string,
  i: number,
  language: string,
  allowBare: boolean,
  state: ScanState,
): Span | null {
  const char = line[i];
  if (char === '"' || char === "'" || char === '`') {
    return [i, readString(line, i)];
  }
  if (language === 'py') {
    const quoteAt = pythonStringStart(line, i);
    if (quoteAt >= 0) {
      return [i, readString(line, quoteAt)];
    }
  }
  if (char === '/' && language === 'js') {
    const end = readJsRegexOnce(line, i, state);
    return end > 0 ? [i, end] : null;
  }
  if (allowBare && char !== undefined && !/[\s,{}[\]]/.test(char)) {
    return [i, line.length];
  }
  return null;
}

export function findRegexLiteralSpans(line: string, language: string): Span[] {
  const spans: Span[] = [];
  const callOpeners = callOpenersFor(language);
  const state: ScanState = { jsRegexExhausted: false };
  let lastSignificant: string | undefined;

  let i = 0;
  while (i < line.length) {
    const code = line.charCodeAt(i);
    // Whitespace never changes lastSignificant or starts anything.
    if (isWhitespaceCode(code)) {
      i += 1;
      continue;
    }
    const char = line[i];

    if (lineCommentStart(line, i, language)) {
      break;
    }

    // Openers are only tried at token starts, which is what keeps this linear.
    const atTokenStart =
      (i === 0 || !isIdentifierCode(line.charCodeAt(i - 1))) &&
      (isIdentifierCode(code) || char === '"' || char === "'");
    if (atTokenStart) {
      let argStart = -1;
      let allowBare = false;
      if (CALL_OPENER_FIRST.has(char)) {
        for (const opener of callOpeners) {
          argStart = probe(opener, line, i);
          if (argStart >= 0) {
            break;
          }
        }
      }
      if (argStart < 0 && PROPERTY_OPENER_FIRST.has(char)) {
        argStart = probe(PROPERTY_OPENER, line, i);
        // Unquoted values only make sense for config formats (YAML).
        allowBare = argStart >= 0 && language === '*';
      }
      if (argStart >= 0) {
        const span = literalAt(line, argStart, language, allowBare, state);
        if (span) {
          spans.push(span);
          i = span[1];
          lastSignificant = line[span[1] - 1];
          continue;
        }
        i = argStart;
        continue;
      }
    }

    // No opener here: skip the rest of the identifier in one step. None of
    // its characters can start a comment, string or regex, and walking them
    // one by one is most of the cost on a long minified line.
    if (isIdentifierCode(code)) {
      let j = i + 1;
      while (j < line.length && isIdentifierCode(line.charCodeAt(j))) {
        j += 1;
      }
      lastSignificant = line[j - 1];
      i = j;
      continue;
    }

    if (char === '"' || char === "'" || char === '`') {
      i = readString(line, i);
      lastSignificant = char;
      continue;
    }

    if (
      char === '/' &&
      language === 'js' &&
      (lastSignificant === undefined ||
        REGEX_ALLOWED_AFTER.has(lastSignificant))
    ) {
      const end = readJsRegexOnce(line, i, state);
      if (end > 0) {
        const closing = line.lastIndexOf('/', end - 1);
        if (qualifiesAsRegexBody(line.slice(i + 1, closing))) {
          spans.push([i, end]);
        }
        i = end;
        lastSignificant = '/';
        continue;
      }
    }

    lastSignificant = char;
    i += 1;
  }
  return spans;
}

export function isInsideRegexLiteral(
  line: string,
  matchStart: number,
  matchLength: number,
  language: string,
): boolean {
  const matchEnd = matchStart + matchLength;
  return findRegexLiteralSpans(line, language).some(
    ([start, end]) => matchStart >= start && matchEnd <= end,
  );
}
