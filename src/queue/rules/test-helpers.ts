import { readFileSync } from 'fs';
import { join } from 'path';
import { detectLanguage } from './language-detector';
import { Rule } from './rule.interface';
import { runRulesForFile } from './rule-runner';

// Provider-shaped credentials are never written literally in fixture files:
// GitHub push protection (and any secret scanner — Critiq's own included)
// blocks them even when fake, and a literal invites pasting a real value.
// Fixtures reference {{NAME}} placeholders instead; the fake values are
// assembled here by concatenation, so no complete provider-shaped string
// exists anywhere in the repository. Each value still matches its rule's
// regex exactly as a real credential would.
const FIXTURE_SECRETS: Record<string, string> = {
  FAKE_AWS_KEY_1: 'AKIA' + 'TESTONLY0000000A',
  FAKE_AWS_KEY_2: 'AKIA' + 'TESTONLY0000000B',
  FAKE_GITHUB_PAT: 'ghp' + '_' + 'TestOnlyNotARealToken'.padEnd(36, '0'),
  FAKE_GITHUB_SERVER_TOKEN:
    'ghs' + '_' + 'TestOnlyNotARealServerToken'.padEnd(36, '0'),
  FAKE_GITLAB_PAT_1: 'glpat' + '-' + 'TestOnlyNotARealToken1',
  FAKE_GITLAB_PAT_2: 'glpat' + '-' + 'TestOnly_NotAReal-Token2',
  FAKE_SLACK_WEBHOOK_1:
    'https://hooks.slack' +
    '.com/services/' +
    'T00000000/B00000000/TestOnlyNotARealSecret00',
  FAKE_SLACK_WEBHOOK_2:
    'https://hooks.slack' +
    '.com/services/' +
    'T0TEST000/B0TEST000/TestOnlyNotARealSecret11',
  PEM_RSA_PRIVATE_HEADER: '-----BEGIN RSA ' + 'PRIVATE KEY-----',
  PEM_RSA_PRIVATE_FOOTER: '-----END RSA ' + 'PRIVATE KEY-----',
  PEM_OPENSSH_PRIVATE_HEADER: '-----BEGIN OPENSSH ' + 'PRIVATE KEY-----',
  PEM_OPENSSH_PRIVATE_FOOTER: '-----END OPENSSH ' + 'PRIVATE KEY-----',
};

function expandPlaceholders(content: string, fixturePath: string): string {
  return content.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, name: string) => {
    const value = FIXTURE_SECRETS[name];
    if (value === undefined) {
      throw new Error(
        `Unknown fixture placeholder {{${name}}} in ${fixturePath}`,
      );
    }
    return value;
  });
}

// Fixtures are plain source files (not diff/patch text) — every line in
// the fixture is treated as newly added, since these tests exercise one
// rule's regex logic directly, not the diff-parsing step (that's
// diff-parser.spec.ts's job). newLine numbers start at 1, matching how a
// brand-new file's first hunk would be numbered.
export function loadFixtureAsAddedLines(
  ruleId: string,
  fixtureName: string,
): { filePath: string; addedLines: { newLine: number; text: string }[] } {
  const filePath = join(__dirname, 'fixtures', ruleId, fixtureName);
  const content = expandPlaceholders(readFileSync(filePath, 'utf8'), filePath);
  const addedLines = content.split('\n').map((text, index) => ({
    newLine: index + 1,
    text,
  }));
  return { filePath: fixtureName, addedLines };
}

// `overrides` exists for rules that key on something a fixture file cannot
// express by being a file: a diff status (file rules), or a path that has to
// look like a real repo path rather than the bare fixture name (skip-list
// behaviour, e.g. `src/payment.test.ts` vs `src/payment.ts`).
export interface FixtureOverrides {
  filePath?: string;
  status?: 'added' | 'removed' | 'modified' | 'renamed';
  previousPath?: string | null;
  sizeBytes?: number;
}

export function runRuleAgainstFixture(
  rule: Rule,
  fixtureName: string,
  overrides: FixtureOverrides = {},
) {
  const { filePath, addedLines } = loadFixtureAsAddedLines(
    rule.id,
    fixtureName,
  );
  const effectivePath = overrides.filePath ?? filePath;
  // Language comes from the fixture's own name even when filePath is
  // overridden: the override exists to control path-based behaviour, and a
  // fixture named `positive-1.ts` is still TypeScript wherever it pretends
  // to live.
  const language = detectLanguage(fixtureName);
  const budgetState = { elapsedMs: 0 };
  return runRulesForFile({
    rules: [rule],
    filePath: effectivePath,
    language,
    addedLines,
    budgetState,
    status: overrides.status,
    previousPath: overrides.previousPath,
    sizeBytes: overrides.sizeBytes,
  });
}
