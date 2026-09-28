import {
  commentSpanStart,
  commentSyntaxFor,
  CommentSyntax,
  findCommentSpans,
  isInsideComment,
} from './comment-span';

function syntax(filePath: string): CommentSyntax {
  const found = commentSyntaxFor(filePath);
  if (!found) {
    throw new Error(`no comment syntax for ${filePath}`);
  }
  return found;
}

function inComment(filePath: string, line: string, needle: string): boolean {
  const start = line.indexOf(needle);
  if (start < 0) {
    throw new Error(`"${needle}" not in line`);
  }
  return isInsideComment(line, start, filePath);
}

describe('comment-span', () => {
  describe('line comments', () => {
    it.each([
      ['src/a.ts', "// const key = 'value'", 0],
      ['src/a.ts', 'const a = 1; // note', 13],
      ['main.go', 'x := 1 // note', 7],
      ['app.py', "# api_key = 'x'", 0],
      ['app.py', "api_key = 'x'  # rotate me", 15],
      ['query.sql', 'SELECT 1; -- note', 10],
      ['config.yml', 'key: value # note', 11],
    ])('%s: %s starts its comment at %i', (path, line, expected) => {
      expect(commentSpanStart(line, syntax(path))).toBe(expected);
    });

    it('returns -1 when there is no comment', () => {
      expect(commentSpanStart('const a = b / c;', syntax('a.ts'))).toBe(-1);
    });
  });

  describe('strings are not comments', () => {
    it('ignores // inside a string (acceptance 4)', () => {
      const line = 'const url = "http://example.com/x"; const key = \'k\';';
      expect(findCommentSpans(line, syntax('a.ts'))).toEqual([]);
    });

    it('ignores # inside a string', () => {
      expect(findCommentSpans("color = '#fff'", syntax('a.py'))).toEqual([]);
    });

    it('handles escaped quotes', () => {
      const line = 'const s = "a \\" // b"; // real';
      expect(commentSpanStart(line, syntax('a.ts'))).toBe(
        line.indexOf('// real'),
      );
    });

    it('treats a template literal as a string', () => {
      expect(
        findCommentSpans('const u = `http://${host}/x`;', syntax('a.ts')),
      ).toEqual([]);
    });
  });

  describe('# is language-dependent', () => {
    // Acceptance 5: in JS, `#` is a private field or a colour, not a comment.
    it('never treats # as a comment in JS/TS', () => {
      expect(
        findCommentSpans("color: '#fff'; this.#secret = 1", syntax('a.ts')),
      ).toEqual([]);
    });

    // In shell/config formats `#` only starts a comment at line start or
    // after whitespace — `abc#123` is a value.
    it.each(['.env', 'deploy.sh', 'values.yaml', 'Dockerfile', 'app.toml'])(
      'keeps a # inside a %s value',
      (path) => {
        expect(findCommentSpans('PASSWORD=abc#123', syntax(path))).toEqual([]);
        expect(commentSpanStart('PASSWORD=abc #123', syntax(path))).toBe(13);
      },
    );

    it('treats any # outside a string as a comment in Python', () => {
      expect(commentSpanStart('x=1#note', syntax('a.py'))).toBe(3);
    });
  });

  describe('block comments', () => {
    it('finds a block closed on the same line', () => {
      const line = "a(/* key = 'x' */ b)";
      expect(findCommentSpans(line, syntax('a.ts'))).toEqual([
        [2, line.indexOf('*/') + 2],
      ]);
      expect(inComment('a.ts', line, 'key')).toBe(true);
      expect(inComment('a.ts', line, 'b)')).toBe(false);
    });

    it('runs an unclosed block to end of line', () => {
      expect(commentSpanStart('x = 1; /* starts here', syntax('a.ts'))).toBe(7);
    });

    it('finds HTML and CSS comments', () => {
      expect(
        inComment('page.html', '<p>x</p><!-- token: abc -->', 'token'),
      ).toBe(true);
      expect(inComment('site.css', 'a { } /* key: v */', 'key')).toBe(true);
    });

    it('treats a docstring opened at line start as a comment', () => {
      expect(inComment('a.py', '"""api_key = \'x\'"""', 'api_key')).toBe(true);
    });

    it('does not treat a triple-quoted assignment as a docstring', () => {
      expect(inComment('a.py', 'KEY = """abc123"""', 'abc123')).toBe(false);
    });
  });

  it('knows nothing about files without a comment syntax', () => {
    expect(commentSyntaxFor('data.bin')).toBeNull();
    expect(inComment('notes.txt', '# key = x', 'key')).toBe(false);
  });

  // Acceptance 17: runs per match inside the scan job, so it must stay linear
  // on a 1 MB minified line. Growth ratio plus a loose bound, as in
  // regex-literal.spec.ts — a hard 50 ms wall-clock flakes on a loaded box.
  describe('linear time', () => {
    function timeMs(line: string, path: string): number {
      findCommentSpans(line, syntax(path)); // warm up the JIT
      const startedAt = process.hrtime.bigint();
      findCommentSpans(line, syntax(path));
      return Number(process.hrtime.bigint() - startedAt) / 1e6;
    }

    it.each([
      ['no comment', 'a.b(c,d);e=f?g:h/i;', 'a.ts'],
      ['many closed blocks', 'x/*y*/', 'a.ts'],
      ['quotes and escapes', '"a\\"b"+', 'a.ts'],
      ['hash values', 'k=v#1 ', 'app.env'],
    ])('%s: 1 MB line stays fast and scales linearly', (_, unit, path) => {
      const small = unit.repeat(Math.ceil(256_000 / unit.length));
      const large = unit.repeat(Math.ceil(1_024_000 / unit.length));

      const smallMs = timeMs(small, path);
      const largeMs = timeMs(large, path);

      expect(largeMs).toBeLessThan(500);
      expect(largeMs / Math.max(smallMs, 2)).toBeLessThan(10);
    });
  });
});
