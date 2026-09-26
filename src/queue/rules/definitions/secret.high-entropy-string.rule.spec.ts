import { runRulesForFile } from '../rule-runner';
import { secretHighEntropyStringRule } from './secret.high-entropy-string.rule';

// Run through the runner, not `rule.test()` directly: half of what keeps
// this rule quiet is ValueFilter, and testing the regex alone would prove
// the wrong thing.
function scan(text: string, filePath = 'src/config.ts', sizeBytes?: number) {
  return runRulesForFile({
    rules: [secretHighEntropyStringRule],
    filePath,
    language: 'js',
    addedLines: [{ newLine: 12, text }],
    budgetState: { elapsedMs: 0 },
    sizeBytes,
  });
}

describe('secret.high_entropy_string', () => {
  it('flags a random-looking literal behind a neutral name', () => {
    const result = scan('const k = "Zx9!qL2#mN8$vB4@kP7&wR3*";');
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].snippet).toBe('Zx9!****');
  });

  it('flags a long base64-ish blob even with only two character classes', () => {
    const result = scan(
      'const payload = "aGVsbG9Xb3JsZFRoaXNJc0Jhc2U2NEVuY29kZWREYXRh";',
    );
    expect(result.hits).toHaveLength(1);
  });

  it('never puts the full value in the snippet', () => {
    const value = 'Zx9!qL2#mN8$vB4@kP7&wR3*';
    const result = scan(`const k = "${value}";`);
    expect(JSON.stringify(result.hits)).not.toContain(value);
  });

  // Acceptance 22's negatives. Each is long and random-looking by some
  // measure, and each is something people write all the time.
  it.each([
    [
      'a string with spaces',
      'const cls = "flex items-center justify-between px-4";',
    ],
    ['a git sha', 'const sha = "ec10b625ad4e3b3f6544e26f1b5aa2eab5aa7bce";'],
    ['a UUID', 'const id = "550e8400-e29b-41d4-a716-446655440000";'],
    ['an i18n key', 'const t = "home.header.title.long.description.text";'],
    ['a semver range', 'const v = "1.2.3-beta.11+build.2026.09.26";'],
    ['a plain URL', 'const u = "https://api.example.org/v1/resources/list";'],
    [
      'a data URI',
      'const img = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg";',
    ],
    ['an import path', 'import x from "../../shared/utils/formatting/dates";'],
    [
      'an integrity hash',
      'integrity: "sha512-AbCdEfGhIjKlMnOpQrStUvWxYz01234567";',
    ],
    ['a short literal', 'const s = "tooShortToMatter";'],
  ])('does not flag %s', (_label, line) => {
    expect(scan(line).hits).toHaveLength(0);
  });

  it.each(['icons.svg', 'theme.css', 'index.html'])(
    'skips %s entirely',
    (filePath) => {
      const result = scan('const k = "Zx9!qL2#mN8$vB4@kP7&wR3*";', filePath);
      expect(result.hits).toHaveLength(0);
    },
  );

  it('skips a file above the size ceiling', () => {
    const result = scan(
      'const k = "Zx9!qL2#mN8$vB4@kP7&wR3*";',
      'src/generated.ts',
      2 * 1024 * 1024,
    );
    expect(result.hits).toHaveLength(0);
  });

  it('reports at most one finding per line', () => {
    const result = scan(
      'const a = "Zx9!qL2#mN8$vB4@kP7&wR3*", b = "Qw7$zM4#tY2@nK8&vL5*pR1";',
    );
    expect(result.hits).toHaveLength(1);
  });
});
