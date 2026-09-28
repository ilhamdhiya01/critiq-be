import { SuppressionReason } from '../generated/prisma/enums';
import { classifySuppression } from './suppression';

const { TEST_FILE, REGEX_LITERAL } = SuppressionReason;

function reason(ruleId: string, filePath: string): SuppressionReason | null {
  return classifySuppression({ ruleId, filePath, language: 'js' });
}

describe('classifySuppression — test files (§1a)', () => {
  it.each([
    ['secret.db_url_with_password', TEST_FILE],
    ['config.cors_wildcard_credentials', TEST_FILE],
    ['code.insecure_tls', TEST_FILE],
    ['code.debugger_left', TEST_FILE],
    // eval/SQL/shell stay active in spec files: that code runs in CI.
    ['code.eval_dynamic', null],
    ['code.sql_string_concat', null],
    ['code.shell_injection', null],
  ])('%s in src/auth.spec.ts → %s', (ruleId, expected) => {
    expect(reason(ruleId, 'src/auth.spec.ts')).toBe(expected);
  });

  // Fixtures/testdata are inert data, so every family is suppressed there.
  it.each([
    'code.eval_dynamic',
    'code.sql_string_concat',
    'code.shell_injection',
    'secret.aws_access_key',
  ])('%s under fixtures/ → TEST_FILE', (ruleId) => {
    expect(reason(ruleId, 'src/queue/rules/fixtures/x/positive-1.ts')).toBe(
      TEST_FILE,
    );
  });

  it('suppresses documentation (acceptance 9)', () => {
    expect(reason('secret.db_url_with_password', 'README.md')).toBe(TEST_FILE);
  });

  it('never suppresses real config files as test files', () => {
    expect(reason('secret.assignment_literal', 'tests/.env')).toBeNull();
    expect(
      reason('secret.assignment_literal', 'e2e/docker-compose.yml'),
    ).toBeNull();
  });

  it('does not treat .txt as documentation', () => {
    expect(
      reason('secret.private_key_block', 'keys/deploy-key.txt'),
    ).toBeNull();
  });

  it('leaves production code active', () => {
    expect(reason('secret.db_url_with_password', 'src/config.ts')).toBeNull();
  });
});

describe('classifySuppression — regex literals (§1b)', () => {
  const line = 'const re = /rejectUnauthorized: false|verify=False/;';
  const match = { start: line.indexOf('reject'), length: 25 };

  it('suppresses regex-aware rules inside a regex literal', () => {
    expect(
      classifySuppression({
        ruleId: 'code.insecure_tls',
        filePath: 'src/lint.ts',
        language: 'js',
        lineText: line,
        match,
      }),
    ).toBe(REGEX_LITERAL);
  });

  it('does not apply the regex check to eval/SQL/shell rules', () => {
    const evalLine = 'const re = /eval\\(userInput\\)|exec\\(x\\)/;';
    expect(
      classifySuppression({
        ruleId: 'code.eval_dynamic',
        filePath: 'src/lint.ts',
        language: 'js',
        lineText: evalLine,
        match: { start: evalLine.indexOf('eval'), length: 4 },
      }),
    ).toBeNull();
  });

  it('cannot suppress as REGEX_LITERAL without a match position', () => {
    expect(
      classifySuppression({
        ruleId: 'code.insecure_tls',
        filePath: 'src/lint.ts',
        language: 'js',
        lineText: line,
      }),
    ).toBeNull();
  });
});
