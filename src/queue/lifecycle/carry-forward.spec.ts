import { carryForward, CarryFile } from './carry-forward';

const finding = (id: string, filePath: string, line: number) => ({
  id,
  filePath,
  lineStart: line,
  lineEnd: line,
});

describe('carryForward', () => {
  // Acceptance 1: lines 47 (config.ts) and 110 (session.ts) fixed,
  // roles.ts untouched.
  it('resolves fixed lines and persists untouched files', () => {
    const files: CarryFile[] = [
      {
        path: 'src/config.ts',
        previousPath: null,
        status: 'modified',
        patch: '@@ -47,1 +47,1 @@\n-const pw = "x";\n+const pw = env.PW;',
      },
      {
        path: 'src/auth/session.ts',
        previousPath: null,
        status: 'modified',
        patch:
          '@@ -110,1 +110,1 @@\n-refresh(s).then(apply);\n+await refresh(s).then(apply);',
      },
    ];
    const { persisted, resolved } = carryForward(
      [
        finding('a', 'src/config.ts', 47),
        finding('b', 'src/auth/session.ts', 110),
        finding('c', 'src/auth/roles.ts', 64),
        finding('d', 'src/auth/roles.ts', 88),
      ],
      files,
    );
    expect(resolved.map((f) => f.id).sort()).toEqual(['a', 'b']);
    expect(persisted.map((p) => [p.finding.id, p.lineStart])).toEqual([
      ['c', 64],
      ['d', 88],
    ]);
  });

  // Acceptance 2.
  it('shifts a finding below an inserted line', () => {
    const { persisted } = carryForward(
      [finding('n1', 'src/auth/roles.ts', 88)],
      [
        {
          path: 'src/auth/roles.ts',
          previousPath: null,
          status: 'modified',
          patch: '@@ -87,0 +88,1 @@\n+// cache roles',
        },
      ],
    );
    expect(persisted[0]).toMatchObject({ lineStart: 89, lineEnd: 89 });
  });

  // Acceptance 7.
  it('resolves a removed file and follows a pure rename', () => {
    const { persisted, resolved } = carryForward(
      [finding('x', 'old/a.ts', 5), finding('y', 'gone.ts', 3)],
      [
        {
          path: 'new/a.ts',
          previousPath: 'old/a.ts',
          status: 'renamed',
          patch: '',
        },
        { path: 'gone.ts', previousPath: null, status: 'removed', patch: null },
      ],
    );
    expect(resolved.map((f) => f.id)).toEqual(['y']);
    expect(persisted[0]).toMatchObject({ filePath: 'new/a.ts', lineStart: 5 });
  });

  it('resolves a renamed file whose finding line changed', () => {
    const { resolved } = carryForward(
      [finding('x', 'old/a.ts', 5)],
      [
        {
          path: 'new/a.ts',
          previousPath: 'old/a.ts',
          status: 'renamed',
          patch: '@@ -5,1 +5,1 @@\n-bad()\n+good()',
        },
      ],
    );
    expect(resolved.map((f) => f.id)).toEqual(['x']);
  });

  it('keeps a finding in place when the file has no patch', () => {
    const { persisted } = carryForward(
      [finding('x', 'big.min.js', 3)],
      [
        {
          path: 'big.min.js',
          previousPath: null,
          status: 'modified',
          patch: null,
        },
      ],
    );
    expect(persisted).toHaveLength(1);
  });
});
