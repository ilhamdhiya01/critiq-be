import {
  isCommentLine,
  isInsideStringLiteral,
  matchesAsCode,
} from './line-context';

describe('isCommentLine', () => {
  it.each([
    '// rejectUnauthorized: false',
    '  /* note */',
    '   * JSDoc continuation',
    '# python or yaml comment',
  ])('treats %s as a comment', (line) => {
    expect(isCommentLine(line)).toBe(true);
  });

  it.each(['const a = 1; // trailing', 'agent({ rejectUnauthorized: false })'])(
    'treats %s as code',
    (line) => {
      expect(isCommentLine(line)).toBe(false);
    },
  );
});

describe('isInsideStringLiteral', () => {
  it('detects a position inside a quoted string', () => {
    const line = `const msg = 'set rejectUnauthorized: false';`;
    expect(isInsideStringLiteral(line, line.indexOf('reject'))).toBe(true);
  });

  it('detects a position outside any string', () => {
    const line = `https.Agent({ rejectUnauthorized: false, ca: 'x' })`;
    expect(isInsideStringLiteral(line, line.indexOf('reject'))).toBe(false);
  });

  it('honours escaped quotes', () => {
    const line = `const s = 'it\\'s fine'; eval(x)`;
    expect(isInsideStringLiteral(line, line.indexOf('eval'))).toBe(false);
  });
});

describe('matchesAsCode', () => {
  const pattern = /rejectUnauthorized\s*:\s*false/;

  it('matches real code', () => {
    expect(
      matchesAsCode(pattern, 'new Agent({ rejectUnauthorized: false })'),
    ).toBe(true);
  });

  it('ignores comments and string prose', () => {
    expect(matchesAsCode(pattern, '// rejectUnauthorized: false')).toBe(false);
    expect(
      matchesAsCode(
        pattern,
        `const m = 'never use rejectUnauthorized: false';`,
      ),
    ).toBe(false);
  });

  it('still matches when a later occurrence on the line is real code', () => {
    const line = `log('rejectUnauthorized: false'); agent({ rejectUnauthorized: false })`;
    expect(matchesAsCode(pattern, line)).toBe(true);
  });
});
