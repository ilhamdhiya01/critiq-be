import { parsePatch } from './diff-parser';

describe('parsePatch', () => {
  it('parses a single hunk with added, deleted, and context lines', () => {
    const patch = [
      '@@ -10,3 +10,4 @@',
      ' function foo() {',
      '-  return 1;',
      '+  const x = 2;',
      '+  return x;',
      ' }',
    ].join('\n');

    const hunks = parsePatch(patch);

    expect(hunks).toHaveLength(1);
    expect(hunks[0].newStart).toBe(10);
    expect(hunks[0].lines).toMatchObject([
      { type: 'context', newLine: 10, text: 'function foo() {' },
      { type: 'del', newLine: null, text: '  return 1;' },
      { type: 'add', newLine: 11, text: '  const x = 2;' },
      { type: 'add', newLine: 12, text: '  return x;' },
      { type: 'context', newLine: 13, text: '}' },
    ]);
  });

  it('parses multiple hunks in the same patch independently', () => {
    const patch = [
      '@@ -1,2 +1,2 @@',
      '-old top',
      '+new top',
      ' unchanged',
      '@@ -50,2 +50,3 @@',
      ' context',
      '+new bottom',
    ].join('\n');

    const hunks = parsePatch(patch);

    expect(hunks).toHaveLength(2);
    expect(hunks[0].newStart).toBe(1);
    expect(hunks[1].newStart).toBe(50);
    expect(hunks[1].lines).toMatchObject([
      { type: 'context', newLine: 50, text: 'context' },
      { type: 'add', newLine: 51, text: 'new bottom' },
    ]);
  });

  it('returns no hunks for an empty patch', () => {
    expect(parsePatch('')).toEqual([]);
  });

  it('ignores content before the first hunk header', () => {
    const patch = [
      '\\ No newline at end of file',
      '@@ -1,1 +1,1 @@',
      '+only line',
    ].join('\n');

    const hunks = parsePatch(patch);

    expect(hunks).toHaveLength(1);
    expect(hunks[0].lines).toMatchObject([
      { type: 'add', newLine: 1, text: 'only line' },
    ]);
  });

  // v1.5.1 langkah 3: old-side numbers, for carrying findings forward.
  it('tracks old-side line numbers and hunk old ranges', () => {
    const [hunk] = parsePatch(
      '@@ -10,3 +10,3 @@\n function foo() {\n-  return 1;\n+  return 2;\n }',
    );
    expect(hunk.oldStart).toBe(10);
    expect(hunk.oldCount).toBe(3);
    expect(hunk.lines.map((l) => [l.type, l.oldLine, l.newLine])).toEqual([
      ['context', 10, 10],
      ['del', 11, null],
      ['add', null, 11],
      ['context', 12, 12],
    ]);
  });

  it('reads a missing old count as 1 and a pure insertion as 0', () => {
    expect(parsePatch('@@ -5 +5,2 @@\n x\n+y')[0].oldCount).toBe(1);
    expect(parsePatch('@@ -5,0 +6,1 @@\n+y')[0].oldCount).toBe(0);
  });
});
