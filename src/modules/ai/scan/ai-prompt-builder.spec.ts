import { FindingCategory } from '../../../generated/prisma/enums';
import {
  buildReviewPrompt,
  PromptBuildInput,
  REDACTED,
  renderFile,
} from './ai-prompt-builder';

function patch(lines: string[], newStart = 1): string {
  return `@@ -${newStart},0 +${newStart},${lines.length} @@\n${lines.map((l) => `+${l}`).join('\n')}`;
}

function input(overrides: Partial<PromptBuildInput> = {}): PromptBuildInput {
  return {
    repoPath: 'acme/api',
    pullTitle: 'Add session refresh',
    pullDescription: 'Rotates the session token.',
    sourceBranch: 'feature/refresh',
    targetBranch: 'main',
    files: [],
    staticFindings: [],
    locale: 'en',
    contextLines: 30,
    maxInputTokens: 60_000,
    maxOutputTokens: 4000,
    timeoutMs: 90_000,
    ...overrides,
  };
}

describe('renderFile', () => {
  it('numbers every line on the new side and marks added lines', () => {
    const rendered = renderFile(
      {
        path: 'a.ts',
        status: 'modified',
        patch: '@@ -1,2 +1,3 @@\n const a = 1;\n+const b = 2;\n const c = 3;',
        headLines: null,
      },
      new Set(),
      30,
    )!;
    expect(rendered.text).toContain('      1 | const a = 1;');
    expect(rendered.text).toContain('+     2 | const b = 2;');
    expect([...rendered.addedLines]).toEqual([2]);
  });

  it('widens hunks with head-file context and merges overlapping windows', () => {
    const head = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
    head[49] = 'const x = compute();';
    const rendered = renderFile(
      {
        path: 'a.ts',
        status: 'modified',
        patch: '@@ -50,0 +50,1 @@\n+const x = compute();',
        headLines: head,
      },
      new Set(),
      3,
    )!;
    const numbered = rendered.text.split('\n').slice(1);
    expect(numbered[0]).toContain('   47 | line 47');
    expect(numbered[numbered.length - 1]).toContain('   53 | line 53');
    expect(rendered.text).toContain('+    50 | const x = compute();');
  });
});

describe('buildReviewPrompt', () => {
  const secretValue = 'AKIA' + 'TESTONLYNOTREAL0';

  it('redacts lines a static secret rule flagged', () => {
    const result = buildReviewPrompt(
      input({
        files: [
          {
            path: 'src/aws.ts',
            status: 'added',
            patch: patch([
              `const key = '${secretValue}';`,
              'export default key;',
            ]),
            headLines: null,
          },
        ],
        staticFindings: [
          {
            ruleId: 'secret.aws_access_key',
            category: FindingCategory.SECRET,
            filePath: 'src/aws.ts',
            lineStart: 1,
            lineEnd: 1,
            title: 'AWS access key',
            suppressed: false,
          },
        ],
      }),
    );
    expect(result.request.user).not.toContain(secretValue);
    expect(result.request.user).toContain(`+     1 | ${REDACTED}`);
    expect(result.request.user).toContain(
      '- [secret] src/aws.ts:1-1 AWS access key',
    );
  });

  it('never sends config/infra files', () => {
    const result = buildReviewPrompt(
      input({
        files: [
          {
            path: '.env',
            status: 'added',
            patch: patch(['A=1']),
            headLines: null,
          },
          {
            path: 'src/a.ts',
            status: 'added',
            patch: patch(['x()']),
            headLines: null,
          },
        ],
      }),
    );
    expect(result.sentFiles.has('.env')).toBe(false);
    expect(result.filesOmitted).toContain('.env');
    expect(result.request.user).not.toContain('A=1');
  });

  it('puts files with static findings first', () => {
    const result = buildReviewPrompt(
      input({
        files: [
          {
            path: 'docs/notes.txt',
            status: 'added',
            patch: patch(['a']),
            headLines: null,
          },
          {
            path: 'src/big.ts',
            status: 'added',
            patch: patch(['b', 'c']),
            headLines: null,
          },
          {
            path: 'src/flagged.py',
            status: 'added',
            patch: patch(['d'.repeat(50)]),
            headLines: null,
          },
        ],
        staticFindings: [
          {
            ruleId: 'code.eval_dynamic',
            category: FindingCategory.INJECTION,
            filePath: 'src/flagged.py',
            lineStart: 1,
            lineEnd: 1,
            title: 'eval',
            suppressed: false,
          },
        ],
      }),
    );
    const user = result.request.user;
    expect(user.indexOf('### src/flagged.py')).toBeLessThan(
      user.indexOf('### src/big.ts'),
    );
    expect(user.indexOf('### src/big.ts')).toBeLessThan(
      user.indexOf('### docs/notes.txt'),
    );
  });

  // Acceptance 14.
  it('drops files from the end past the token budget and says so', () => {
    const files = ['a', 'b', 'c'].map((name) => ({
      path: `src/${name}.ts`,
      status: 'added' as const,
      patch: patch(Array.from({ length: 200 }, (_, i) => `${name}${i}`)),
      headLines: null,
    }));
    const result = buildReviewPrompt(input({ files, maxInputTokens: 2500 }));
    expect(result.filesOmitted.length).toBeGreaterThan(0);
    expect(result.request.user).toContain(
      `OMITTED FOR SIZE: ${result.filesOmitted.join(', ')}`,
    );
    for (const omitted of result.filesOmitted) {
      expect(result.sentFiles.has(omitted)).toBe(false);
    }
  });

  it('truncates the PR description and forces the report_review tool', () => {
    const result = buildReviewPrompt(
      input({ pullDescription: 'x'.repeat(5000) }),
    );
    expect(result.request.user).not.toContain('x'.repeat(2001));
    expect(result.request.tool.name).toBe('report_review');
    expect(result.request.temperature).toBe(0);
  });

  // Acceptance 11.
  it('adds the lifecycle blocks and the incremental mode', () => {
    const result = buildReviewPrompt(
      input({
        mode: 'incremental',
        lifecycle: {
          resolved: [
            {
              category: FindingCategory.ERROR_HANDLING,
              filePath: 'src/auth/session.ts',
              lineStart: 110,
              title: 'Missing error handling in critical path',
            },
          ],
          persisted: [
            {
              category: FindingCategory.PERFORMANCE,
              filePath: 'src/auth/roles.ts',
              lineStart: 88,
              title: 'N+1 query in role resolver',
            },
          ],
        },
      }),
    );
    expect(result.request.user).toContain(
      'RESOLVED IN THIS PUSH (previously reported; the lines changed. Re-report ONLY if the new code still has the same problem):\n- [error_handling] src/auth/session.ts:110 Missing error handling in critical path',
    );
    expect(result.request.user).toContain(
      'PERSISTED FROM PREVIOUS PUSH (unchanged lines, already listed, do not repeat):\n- [performance] src/auth/roles.ts:88 N+1 query in role resolver',
    );
    expect(result.request.system).toContain(
      'Do not restate the original PR summary',
    );
  });

  it('leaves the blocks out of a full review', () => {
    const result = buildReviewPrompt(input());
    expect(result.request.user).not.toContain('RESOLVED IN THIS PUSH');
    expect(result.request.system).toContain(
      'Describe what the pull request changes',
    );
  });
});
