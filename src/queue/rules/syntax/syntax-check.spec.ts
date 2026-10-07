import { parsePatch } from '../../diff/diff-parser';
import {
  checkSyntax,
  reconstructBase,
  SyntaxCheckInput,
  syntaxKindOf,
} from './syntax-check';

const BASE = [
  'function total(items) {',
  '  if (items.length === 0) {',
  '    return 0;',
  '  }',
  '  return items.length;',
  '}',
  '',
].join('\n');

// The reported case: the closing brace of an `if` commented out.
const COMMENTED_BRACE: SyntaxCheckInput = {
  path: 'src/total.js',
  status: 'modified',
  head: BASE.replace('\n  }\n', '\n  // }\n'),
  patch: [
    '@@ -1,6 +1,6 @@',
    ' function total(items) {',
    '   if (items.length === 0) {',
    '     return 0;',
    '-  }',
    '+  // }',
    '   return items.length;',
    ' }',
  ].join('\n'),
};

function hitOf(input: SyntaxCheckInput) {
  const result = checkSyntax(input);
  if (!('hit' in result)) {
    throw new Error(`expected a hit, got skipped: ${result.skipped}`);
  }
  return result.hit;
}

describe('checkSyntax', () => {
  it('flags a commented-out closing brace on the line that did it', () => {
    const hit = hitOf(COMMENTED_BRACE);
    expect(hit).toMatchObject({
      ruleId: 'code.syntax_error',
      title: 'Syntax error',
      filePath: 'src/total.js',
      // Babel stops at end of file; the finding sits on the changed line.
      lineStart: 4,
      lineEnd: 4,
      snippet: '// }',
    });
    expect(hit.message).toMatch(/^This change leaves the file unparseable: /);
    expect(hit.message).toMatch(/the parser stopped at line 7/);
  });

  it('flags a deleted closing brace, where no line was added', () => {
    const hit = hitOf({
      ...COMMENTED_BRACE,
      head: BASE.replace('\n  }\n', '\n'),
      patch: [
        '@@ -1,6 +1,5 @@',
        ' function total(items) {',
        '   if (items.length === 0) {',
        '     return 0;',
        '-  }',
        '   return items.length;',
        ' }',
      ].join('\n'),
    });
    // The line now standing where the brace was.
    expect(hit.lineStart).toBe(4);
  });

  it('accepts a GitLab patch ending in a newline', () => {
    expect(
      checkSyntax({ ...COMMENTED_BRACE, patch: `${COMMENTED_BRACE.patch}\n` }),
    ).toHaveProperty('hit');
  });

  it('keeps one fingerprint per file, whatever the line', () => {
    const moved = hitOf({
      ...COMMENTED_BRACE,
      head: `// header\n${COMMENTED_BRACE.head}`,
      patch: [
        '@@ -1,6 +1,7 @@',
        '+// header',
        ' function total(items) {',
        '   if (items.length === 0) {',
        '     return 0;',
        '-  }',
        '+  // }',
        '   return items.length;',
        ' }',
      ].join('\n'),
    });
    expect(moved.fingerprint).toBe(hitOf(COMMENTED_BRACE).fingerprint);
  });

  it('passes a file that still parses', () => {
    expect(
      checkSyntax({
        ...COMMENTED_BRACE,
        head: BASE.replace('return 0;', 'return -1;'),
        patch: [
          '@@ -1,4 +1,4 @@',
          ' function total(items) {',
          '   if (items.length === 0) {',
          '-    return 0;',
          '+    return -1;',
          '   }',
        ].join('\n'),
      }),
    ).toEqual({ skipped: 'parses' });
  });

  // Only an error this change introduced.
  it('ignores a file that was already broken before the change', () => {
    const brokenBase = BASE.replace('\n  }\n', '\n');
    expect(
      checkSyntax({
        path: 'src/total.js',
        status: 'modified',
        head: brokenBase.replace('return 0;', 'return -1;'),
        patch: [
          '@@ -1,5 +1,5 @@',
          ' function total(items) {',
          '   if (items.length === 0) {',
          '-    return 0;',
          '+    return -1;',
          '   return items.length;',
          ' }',
        ].join('\n'),
      }),
    ).toEqual({ skipped: 'base_broken' });
  });

  // Incremental scan of a file already holding the finding.
  it('reports a pre-existing error when the base check is off', () => {
    const brokenBase = BASE.replace('\n  }\n', '\n');
    const result = checkSyntax({
      path: 'src/total.js',
      status: 'modified',
      head: brokenBase.replace('return 0;', 'return -1;'),
      patch: [
        '@@ -1,5 +1,5 @@',
        ' function total(items) {',
        '   if (items.length === 0) {',
        '-    return 0;',
        '+    return -1;',
        '   return items.length;',
        ' }',
      ].join('\n'),
      skipBaseCheck: true,
    });
    expect(result).toHaveProperty('hit');
  });

  it('skips when the patch does not fit the file', () => {
    expect(
      checkSyntax({
        ...COMMENTED_BRACE,
        patch: COMMENTED_BRACE.patch.replace(
          ' function total(items) {',
          ' function other(items) {',
        ),
      }),
    ).toEqual({ skipped: 'base_unknown' });
  });

  it('flags a broken added file, with no base to compare', () => {
    const head = 'export const a = {\n  b: 1,\n';
    const hit = hitOf({
      path: 'src/new.ts',
      status: 'added',
      head,
      patch: ['@@ -0,0 +1,2 @@', '+export const a = {', '+  b: 1,'].join('\n'),
    });
    expect(hit.lineStart).toBe(2);
  });

  // The parser's limit, not a broken file: valid syntax behind a plugin.
  it('does not report syntax the parser has no plugin for', () => {
    expect(
      checkSyntax({
        path: 'src/pipe.js',
        status: 'added',
        head: 'const y = x |> f(%);\n',
        patch: '@@ -0,0 +1 @@\n+const y = x |> f(%);',
      }),
    ).toEqual({ skipped: 'unsupported_syntax' });
  });

  it.each([
    ['generics in .ts', 'src/id.ts', 'export const id = <T,>(x: T): T => x;\n'],
    ['JSX in .tsx', 'src/A.tsx', 'export const A = () => <div>{1}</div>;\n'],
    ['JSX in .js', 'src/A.js', 'export const A = () => <div />;\n'],
    ['decorators in .ts', 'src/a.ts', '@Injectable()\nexport class A {}\n'],
    ['a CommonJS script', 'src/c.cjs', 'return module.exports;\n'],
  ])('parses %s', (_label, path, head) => {
    expect(
      checkSyntax({
        path,
        status: 'added',
        head,
        patch: `@@ -0,0 +1 @@\n+${head.split('\n')[0]}`,
      }),
    ).toEqual({ skipped: 'parses' });
  });

  describe('JSON', () => {
    it('flags invalid JSON without quoting its content', () => {
      const head = '{\n  "token": "do-not-echo-me"\n  "next": 1\n}\n';
      const hit = hitOf({
        path: 'config/app.json',
        status: 'added',
        head,
        patch: [
          '@@ -0,0 +1,4 @@',
          '+{',
          '+  "token": "do-not-echo-me"',
          '+  "next": 1',
          '+}',
        ].join('\n'),
      });
      expect(hit.message).toMatch(/Invalid JSON/);
      expect(hit.message).not.toContain('do-not-echo-me');
      expect(hit.lineStart).toBe(3);
    });

    it('accepts a byte-order mark', () => {
      expect(
        checkSyntax({
          path: 'a.json',
          status: 'added',
          head: '﻿{"a": 1}\n',
          patch: '@@ -0,0 +1 @@\n+﻿{"a": 1}',
        }),
      ).toEqual({ skipped: 'parses' });
    });
  });
});

describe('syntaxKindOf', () => {
  it.each([
    ['src/a.js', 'js'],
    ['src/a.JSX', 'js'],
    ['src/a.mjs', 'js'],
    ['src/a.ts', 'ts'],
    ['src/a.tsx', 'tsx'],
    ['package.json', 'json'],
  ])('%s → %s', (path, kind) => {
    expect(syntaxKindOf(path)).toBe(kind);
  });

  // JSON with comments, read by tools that allow them.
  it.each([
    'tsconfig.json',
    'packages/api/tsconfig.build.json',
    'jsconfig.json',
    '.eslintrc.json',
    '.vscode/settings.json',
    '.devcontainer/devcontainer.json',
    'src/a.py',
    'Dockerfile',
  ])('skips %s', (path) => {
    expect(syntaxKindOf(path)).toBeNull();
  });
});

describe('reconstructBase', () => {
  it('rebuilds the file before the change', () => {
    expect(
      reconstructBase(COMMENTED_BRACE.head, parsePatch(COMMENTED_BRACE.patch)),
    ).toBe(BASE);
  });

  it('rebuilds across several hunks, an insertion and a deletion', () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    const after = [...before];
    after.splice(2, 0, 'inserted');
    after.splice(15, 1);
    const patch = [
      '@@ -2,2 +2,3 @@',
      ' line 2',
      '+inserted',
      ' line 3',
      '@@ -14,3 +15,2 @@',
      ' line 14',
      '-line 15',
      ' line 16',
    ].join('\n');
    expect(reconstructBase(after.join('\n'), parsePatch(patch))).toBe(
      before.join('\n'),
    );
  });
});
