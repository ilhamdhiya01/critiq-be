import {
  runSyntaxChecks,
  syntaxCheckFiles,
  SyntaxStepFile,
} from './syntax-step';

const file = (overrides: Partial<SyntaxStepFile>): SyntaxStepFile => ({
  path: 'src/a.js',
  previousPath: null,
  status: 'modified',
  patch: '@@ -1 +1 @@\n-const a = 1;\n+const a = 2;',
  ...overrides,
});

describe('syntaxCheckFiles', () => {
  it('keeps changed files it can read and rebuild', () => {
    const { files, capped } = syntaxCheckFiles(
      [
        file({ path: 'src/a.js' }),
        file({ path: 'src/gone.js', status: 'removed' }),
        file({ path: 'src/big.js', patch: null }),
        file({ path: 'src/cut.js', truncated: true }),
        file({ path: 'dist/app.min.js' }),
        file({ path: 'src/main.py' }),
        file({ path: 'tsconfig.json' }),
      ],
      50,
    );
    expect(files.map((f) => f.path)).toEqual(['src/a.js']);
    expect(capped).toBe(0);
  });

  it('checks the first files in diff order and counts the rest', () => {
    const { files, capped } = syntaxCheckFiles(
      ['a', 'b', 'c'].map((name) => file({ path: `src/${name}.ts` })),
      2,
    );
    expect(files.map((f) => f.path)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(capped).toBe(1);
  });

  it('is off at 0', () => {
    expect(syntaxCheckFiles([file({})], 0).files).toEqual([]);
  });
});

describe('runSyntaxChecks', () => {
  const broken = file({
    path: 'src/broken.js',
    patch: '@@ -1 +1 @@\n-const a = 1;\n+const a = (;',
  });
  const fine = file({ path: 'src/fine.js' });
  const missing = file({ path: 'src/missing.js' });
  const contents = new Map<string, string | null>([
    ['src/broken.js', 'const a = (;'],
    ['src/fine.js', 'const a = 2;'],
    ['src/missing.js', null],
  ]);

  it('reports hits, and which files it could decide', () => {
    const result = runSyntaxChecks(
      [broken, fine, missing] as (SyntaxStepFile & { patch: string })[],
      contents,
      { knownBroken: new Set(), capped: 2 },
    );
    expect(result.hits.map((hit) => hit.filePath)).toEqual(['src/broken.js']);
    // A file it could not read is undecided: its finding carries as before.
    expect([...result.decidedPaths].sort()).toEqual([
      'src/broken.js',
      'src/fine.js',
    ]);
    expect(result.skipped).toEqual({ capped: 2, parses: 1, unavailable: 1 });
  });

  it('skips the base check for a file already holding a finding', () => {
    // Head and base both broken: normally base_broken, nothing reported.
    const stillBroken = file({
      path: 'src/still.js',
      patch: '@@ -1,2 +1,2 @@\n const a = (;\n-const b = 1;\n+const b = 2;',
    });
    const head = new Map([['src/still.js', 'const a = (;\nconst b = 2;']]);
    const files = [stillBroken] as (SyntaxStepFile & { patch: string })[];

    expect(
      runSyntaxChecks(files, head, { knownBroken: new Set(), capped: 0 }).hits,
    ).toHaveLength(0);
    expect(
      runSyntaxChecks(files, head, {
        knownBroken: new Set(['src/still.js']),
        capped: 0,
      }).hits,
    ).toHaveLength(1);
  });
});
