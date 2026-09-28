import { analyzeDiff } from './analyze-diff';
import { parsePatch } from './diff/diff-parser';
import { loadDiffFixture } from './diff/test-helpers';
import { RULES } from './rules/rules';

// Acceptance 1 of the v1.5.0 delta 2. The fixture is the real diff of the
// delta-1 PR on critiq-be (`git diff $(git merge-base origin/main
// 3fdfbc8)...3fdfbc8`): the regex-literal helper and ValueFilter with all
// their comments. Under ruleset 2026.09.4 it produced 5 Critical findings,
// all false positives — secret.high_entropy_string on an operator string,
// and assignment/entropy hits on comment lines describing templates and
// ternaries.
describe('scan of the delta-1 PR (regex helper with comments)', () => {
  const files = loadDiffFixture('regex-helper-with-comments.diff');
  const result = analyzeDiff(files, { maxDiffBytes: 10_000_000 });
  const findings = [...result.active, ...result.suppressed];

  it('parses the whole diff', () => {
    expect(files.length).toBeGreaterThan(50);
    expect(result.diffTooLarge).toBe(false);
    expect(result.crashes).toEqual([]);
  });

  it('has no active finding', () => {
    expect(
      result.active.map((f) => `${f.ruleId} ${f.filePath}:${f.lineStart}`),
    ).toEqual([]);
    expect(result.activeCount).toBe(0);
  });

  // The prompt also asks for ≥ 2 findings suppressed as COMMENT here. That
  // cannot hold together with its own §3/§4: value validation runs first,
  // and the flagged comment lines carry a template (`{repoId}`) or a
  // ternary branch (`'unknown_repo'`) — not a finding at all, so never
  // suppressed either. COMMENT itself is covered in analyze-diff.spec.ts
  // (acceptance 3 and 7). What matters for this PR: the flagged lines
  // produce nothing, active or suppressed.
  it.each([
    "const REGEX_ALLOWED_AFTER = new Set('(,=:[!&|?{};+-*%<>~^');",
    '// `scan:{repoId}:{prNumber}:{headSha}`. Generated credentials',
    "// `cond ? 'no_secret_configured' : 'unknown_repo'`",
  ])('reports nothing on the line %s', (text) => {
    const located = files.flatMap((file) =>
      parsePatch(file.patch ?? '')
        .flatMap((hunk) => hunk.lines)
        .filter((line) => line.type === 'add' && line.text.startsWith(text))
        .map((line) => ({ filePath: file.path, line: line.newLine })),
    );
    expect(located.length).toBeGreaterThan(0);
    for (const { filePath, line } of located) {
      expect(
        findings.filter(
          (f) =>
            f.filePath === filePath &&
            line !== null &&
            f.lineStart <= line &&
            line <= f.lineEnd,
        ),
      ).toEqual([]);
    }
  });

  it('only reports rules that are in the registered set', () => {
    const registered = new Set(RULES.map((rule) => rule.id));
    expect(findings.filter((f) => !registered.has(f.ruleId))).toEqual([]);
  });
});
