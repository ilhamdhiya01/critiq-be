import { SuppressionReason } from '../generated/prisma/enums';
import {
  analyzeDiff,
  DiffFile,
  MAX_ACTIVE_FINDINGS,
  MAX_SUPPRESSED_FINDINGS,
} from './analyze-diff';
import { Rule } from './rules/rule.interface';

const { TEST_FILE, REGEX_LITERAL } = SuppressionReason;

function addedFile(path: string, lines: string[]): DiffFile {
  const patch =
    `@@ -0,0 +1,${lines.length} @@\n` +
    lines.map((line) => `+${line}`).join('\n');
  return { path, previousPath: null, status: 'added', patch };
}

function analyze(files: DiffFile[], rules?: Rule[]) {
  return analyzeDiff(files, { maxDiffBytes: 10_000_000, rules });
}

// ruleId → suppressedReason, for compact assertions.
function outcomes(path: string, line: string): Record<string, string | null> {
  const result = analyze([addedFile(path, [line])]);
  return Object.fromEntries(
    [...result.active, ...result.suppressed].map((finding) => [
      finding.ruleId,
      finding.suppressedReason,
    ]),
  );
}

// Acceptance numbers refer to §6 of the v1.5.0 suppression delta prompt.
describe('analyzeDiff — suppression', () => {
  // Acceptance 2. The prompt's exact line holds `\s*` literally, which the
  // (unchanged) insecure_tls regex does not match, so it yields nothing at
  // all. The variant whose body does match is what exercises suppression.
  it('stores a TLS option inside a JS regex literal as REGEX_LITERAL', () => {
    expect(
      outcomes('src/lint.ts', 'const re = /rejectUnauthorized:\\s*false/;'),
    ).toEqual({});
    expect(
      outcomes(
        'src/lint.ts',
        'const re = /rejectUnauthorized: false|verify=False/;',
      ),
    ).toEqual({ 'code.insecure_tls': REGEX_LITERAL });
  });

  // Acceptance 3.
  it('keeps the real option active', () => {
    expect(
      outcomes('src/client.ts', 'const opts = { rejectUnauthorized: false };'),
    ).toEqual({ 'code.insecure_tls': null });
  });

  // Acceptance 4: division is not a regex, so this is not suppressed.
  it('does not mistake division for a regex literal', () => {
    expect(
      outcomes(
        'src/math.ts',
        'const ratio = a / b / c; // rejectUnauthorized: false',
      ),
    ).toEqual({ 'code.insecure_tls': null });
  });

  // Acceptance 5.
  it('never reports a key-pattern property as an active AWS key', () => {
    const result = outcomes('src/rules.ts', "pattern: 'AKIA[0-9A-Z]{16}'");
    expect(result['secret.aws_access_key']).toBeUndefined();
    for (const reason of Object.values(result)) {
      expect(reason).toBe(REGEX_LITERAL);
    }
  });

  // Acceptance 6: stored, not dropped.
  it('stores a DB URL in a spec file as TEST_FILE', () => {
    const result = analyze([
      addedFile('src/auth.spec.ts', [
        "const url = 'postgres://app:S3cret!@db/prod';",
      ]),
    ]);
    expect(result.activeCount).toBe(0);
    expect(result.suppressed).toContainEqual(
      expect.objectContaining({
        ruleId: 'secret.db_url_with_password',
        suppressedReason: TEST_FILE,
      }),
    );
  });

  // Acceptance 7. The rule only recognises child_process.exec — a bare
  // `exec(userInput)` is not flagged anywhere, test file or not.
  it('keeps shell injection active in a spec file', () => {
    expect(
      outcomes('src/auth.spec.ts', 'child_process.exec(userInput)'),
    ).toEqual({ 'code.shell_injection': null });
  });

  // Acceptance 8.
  it('suppresses a debugger statement in a spec file', () => {
    expect(outcomes('src/auth.spec.ts', 'debugger;')).toEqual({
      'code.debugger_left': TEST_FILE,
    });
  });

  // Acceptance 9.
  it('suppresses a DB URL in documentation', () => {
    expect(
      outcomes('README.md', 'DATABASE_URL=postgres://user:pass@host/db'),
    ).toEqual({ 'secret.db_url_with_password': TEST_FILE });
  });

  // Acceptance 10. assignment_literal no longer fires at all: ValueFilter
  // rejects `re.compile(r` as a call expression.
  it('suppresses a Python re.compile pattern', () => {
    const result = outcomes(
      'src/detect.py',
      'SECRET_RE = re.compile(r"(api[_-]?key)\\s*=\\s*\\w{16,}")',
    );
    expect(Object.keys(result).length).toBeGreaterThan(0);
    for (const reason of Object.values(result)) {
      expect(reason).toBe(REGEX_LITERAL);
    }
  });

  // Acceptance 11, first half: the path is part of the fingerprint, so the
  // same line in a source file and its spec are two findings.
  it('keeps the active and the suppressed copy in different files', () => {
    const line = 'const client = new Client({ rejectUnauthorized: false });';
    const result = analyze([
      addedFile('src/a.ts', [line]),
      addedFile('src/a.spec.ts', [line]),
    ]);
    expect(result.active.map((f) => f.filePath)).toEqual(['src/a.ts']);
    expect(result.suppressed.map((f) => f.filePath)).toEqual(['src/a.spec.ts']);
  });

  it('suppresses every family in data fixtures', () => {
    const result = analyze([
      addedFile('test/fixtures/payloads/eval.js', ['eval(userInput);']),
    ]);
    expect(result.activeCount).toBe(0);
    expect(result.suppressed).toContainEqual(
      expect.objectContaining({
        ruleId: 'code.eval_dynamic',
        suppressedReason: TEST_FILE,
      }),
    );
  });
});

describe('analyzeDiff — caps and counts', () => {
  // One finding per line containing MARK; a secret.* id so it is suppressed
  // in spec files, and no snippet so no two lines merge.
  const markerRule: Rule = {
    id: 'secret.test_marker',
    severity: 'critical',
    title: 'Marker',
    message: 'Marker found.',
    languages: '*',
    test: (ctx) =>
      ctx.addedLines
        .filter((line) => line.text.includes('MARK'))
        .map((line) => ({
          lineStart: line.newLine,
          lineEnd: line.newLine,
          snippet: null,
        })),
  };
  const lines = (count: number) =>
    Array.from({ length: count }, (_, i) => `MARK ${i}`);

  // Acceptance 12.
  it('caps storage but counts what was really found', () => {
    const result = analyze(
      [
        addedFile('src/a.ts', lines(600)),
        addedFile('src/a.spec.ts', lines(300)),
      ],
      [markerRule],
    );

    expect(result.activeCount).toBe(600);
    expect(result.active).toHaveLength(MAX_ACTIVE_FINDINGS);
    expect(result.findingsTruncated).toBe(true);

    expect(result.suppressedCount).toBe(300);
    expect(result.suppressed).toHaveLength(MAX_SUPPRESSED_FINDINGS);
    expect(result.suppressedTruncated).toBe(true);
  });

  it('does not truncate below the caps', () => {
    const result = analyze(
      [addedFile('src/a.ts', lines(3)), addedFile('src/a.spec.ts', lines(2))],
      [markerRule],
    );
    expect(result.activeCount).toBe(3);
    expect(result.suppressedCount).toBe(2);
    expect(result.findingsTruncated).toBe(false);
    expect(result.suppressedTruncated).toBe(false);
  });

  it('runs no rule on a diff over the byte limit', () => {
    const result = analyzeDiff([addedFile('src/a.ts', lines(10))], {
      maxDiffBytes: 10,
      rules: [markerRule],
    });
    expect(result.diffTooLarge).toBe(true);
    expect(result.ruleRuns).toBe(0);
    expect(result.activeCount).toBe(0);
  });
});
