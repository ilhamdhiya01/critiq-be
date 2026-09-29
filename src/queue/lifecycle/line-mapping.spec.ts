import { parsePatch } from '../diff/diff-parser';
import { mapLineThroughHunks, mapOldLine } from './line-mapping';

// Acceptance 16: mapLineThroughHunks.
describe('mapLineThroughHunks', () => {
  // Old 10–12 → new 10–13: line 11 replaced by two lines.
  const replace = parsePatch('@@ -10,3 +10,4 @@\n a\n-b\n+b1\n+b2\n c');
  // Insertion of 2 lines after old line 20, and 1 line deleted at old 40.
  const multi = parsePatch(
    '@@ -20,0 +21,2 @@\n+x\n+y\n@@ -40,1 +41,0 @@\n-gone',
  );

  it.each([
    ['before any hunk', replace, 5, 5, { start: 5, end: 5 }],
    ['context line inside a hunk', replace, 10, 10, { start: 10, end: 10 }],
    ['a replaced line is lost', replace, 11, 11, null],
    [
      'context after the replacement shifts',
      replace,
      12,
      12,
      { start: 13, end: 13 },
    ],
    ['after the hunk, shifted by +1', replace, 30, 31, { start: 31, end: 32 }],
    [
      'right before a pure insertion stays put',
      multi,
      20,
      20,
      { start: 20, end: 20 },
    ],
    ['after the insertion shifts by +2', multi, 21, 21, { start: 23, end: 23 }],
    ['a deleted line is lost', multi, 40, 40, null],
    ['after several hunks: +2 then −1', multi, 50, 50, { start: 51, end: 51 }],
    ['a range crossing a deleted line is lost', replace, 10, 12, null],
  ])('%s', (_, hunks, start, end, expected) => {
    expect(mapLineThroughHunks(hunks, start, end)).toEqual(expected);
  });

  it('maps single lines with mapOldLine', () => {
    expect(mapOldLine(replace, 9)).toBe(9);
    expect(mapOldLine(replace, 11)).toBeNull();
  });
});
