import { findRegexLiteralSpans, isInsideRegexLiteral } from './regex-literal';

function inside(line: string, needle: string, language: string): boolean {
  const start = line.indexOf(needle);
  if (start < 0) {
    throw new Error(`"${needle}" not in line`);
  }
  return isInsideRegexLiteral(line, start, needle.length, language);
}

describe('isInsideRegexLiteral', () => {
  it('detects a JS regex literal with metacharacters', () => {
    const line = 'const re = /rejectUnauthorized: false|verify=False/;';
    expect(inside(line, 'rejectUnauthorized: false', 'js')).toBe(true);
  });

  it('does not treat division as a regex (prompt acceptance 4)', () => {
    const line = 'const ratio = a / b / c; // rejectUnauthorized: false';
    expect(inside(line, 'rejectUnauthorized: false', 'js')).toBe(false);
    expect(findRegexLiteralSpans(line, 'js')).toEqual([]);
  });

  it('does not treat a short or metachar-free /…/ as a regex', () => {
    expect(inside('x = /abc/;', 'abc', 'js')).toBe(false);
    expect(inside('x = /just plain words/;', 'plain', 'js')).toBe(false);
  });

  it('detects the first argument of new RegExp(…)', () => {
    const line = "const re = new RegExp('rejectUnauthorized: false', 'i');";
    expect(inside(line, 'rejectUnauthorized: false', 'js')).toBe(true);
    // The flags argument is not the pattern.
    expect(inside(line, "'i'", 'js')).toBe(false);
  });

  it('detects Python re.* first arguments, raw strings included (acceptance 10)', () => {
    const line = 'SECRET_RE = re.compile(r"(api[_-]?key)\\s*=\\s*\\w{16,}")';
    expect(inside(line, 'api[_-]?key', 'py')).toBe(true);
    expect(
      inside("m = re.search('verify=False', text)", 'verify=False', 'py'),
    ).toBe(true);
  });

  it('detects Go regexp.MustCompile arguments, backticks included', () => {
    const line = 'var re = regexp.MustCompile(`InsecureSkipVerify: true`)';
    expect(inside(line, 'InsecureSkipVerify: true', 'go')).toBe(true);
  });

  it('detects pattern/regex/regexp/matcher property values', () => {
    expect(
      inside("pattern: 'AKIA[0-9A-Z]{16}',", 'AKIA[0-9A-Z]{16}', 'js'),
    ).toBe(true);
    expect(
      inside('"regex": "postgres://u:p4ss@h"', 'postgres://u:p4ss@h', '*'),
    ).toBe(true);
    // Unquoted YAML value.
    expect(inside('matcher: ghp_[A-Za-z0-9]{36}', 'ghp_', '*')).toBe(true);
  });

  it('does not treat an ordinary string or property as a regex', () => {
    expect(
      inside(
        'const opts = { rejectUnauthorized: false };',
        'rejectUnauthorized',
        'js',
      ),
    ).toBe(false);
    expect(inside("password: 'hunter2hunter2'", 'hunter2hunter2', 'js')).toBe(
      false,
    );
  });

  it('requires the whole match to be inside the span', () => {
    const line = "const re = /secret|token/; const k = 'abc';";
    const start = line.indexOf('token');
    expect(isInsideRegexLiteral(line, start, 30, 'js')).toBe(false);
  });

  it('still finds a span after an unclosed `/` gave up on regex literals', () => {
    const line = "x = /[unclosed; const p = { pattern: 'AKIA[0-9A-Z]{16}' };";
    expect(inside(line, 'AKIA[0-9A-Z]{16}', 'js')).toBe(true);
  });
});

// Prompt acceptance 15 (1 MB line < 50 ms). This runs inside the scan job for
// every match, so what must hold is linear time on hostile input. A hard 50 ms
// wall-clock assertion flakes on a loaded CI box (a bare loop over 1 MB already
// swings 10–45 ms there), so the absolute bound is generous and the real guard
// is the growth ratio: quadratic input made 4× longer costs ~16×, linear ~4×.
describe('findRegexLiteralSpans — linear time', () => {
  function timeMs(line: string, language: string): number {
    findRegexLiteralSpans(line, language); // warm up the JIT
    const startedAt = process.hrtime.bigint();
    findRegexLiteralSpans(line, language);
    return Number(process.hrtime.bigint() - startedAt) / 1e6;
  }

  it.each([
    ['minified JS', 'a.b(c,d);e=f?g:h/i;', 'js'],
    // Every `/` opens a regex that never closes — was quadratic.
    ['unclosed regex openers', '=/[', 'js'],
    ['unterminated strings', "x='", 'js'],
    ['opener look-alikes', 'new pattern re regexp ', 'js'],
    ['python openers', "re.x r'a' ", 'py'],
    ['yaml values', 'pattern x ', '*'],
  ])('%s: 1 MB line stays fast and scales linearly', (_, unit, language) => {
    const small = unit.repeat(Math.ceil(256_000 / unit.length));
    const large = unit.repeat(Math.ceil(1_024_000 / unit.length));

    const smallMs = timeMs(small, language);
    const largeMs = timeMs(large, language);

    expect(largeMs).toBeLessThan(500);
    // Floor on the small run so timer noise on a sub-millisecond run can't
    // fake a large ratio.
    expect(largeMs / Math.max(smallMs, 2)).toBeLessThan(10);
  });
});
