import { RuleFileContext } from '../rule.interface';
import { secretSensitiveFileAddedRule } from './secret.sensitive-file-added.rule';

// This rule reads nothing but path and status, so a fixture file would only
// obscure what is being tested. Note `addedLines: []` throughout: a file
// rule that needed content would be a bug, since the files it exists to
// catch usually arrive with no patch at all.
function ctx(
  filePath: string,
  status: RuleFileContext['status'] = 'added',
): RuleFileContext {
  return { filePath, language: '*', addedLines: [], status };
}

describe('secret.sensitive_file_added', () => {
  it.each([
    'config/id_rsa',
    'certs/server.pem',
    'deploy/private.key',
    'keys/bundle.p12',
    'gcp/service-account-prod.json',
    'app-credentials.json',
    '.npmrc',
    'ops/secrets.yml',
    'vault/store.kdbx',
  ])('flags %s when added', (path) => {
    const findings = secretSensitiveFileAddedRule.test(ctx(path));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toEqual({ lineStart: 1, lineEnd: 1, snippet: null });
  });

  it('flags a sensitive file that was renamed into place', () => {
    expect(
      secretSensitiveFileAddedRule.test(ctx('config/id_rsa', 'renamed')),
    ).toHaveLength(1);
  });

  // Acceptance 21: a credential file that was already in the repo is a real
  // problem, but not one this PR introduced — and flagging it would fire
  // again on every later commit that happens to touch the file.
  it.each(['modified', 'removed'] as const)(
    'does not flag an existing file with status %s',
    (status) => {
      expect(
        secretSensitiveFileAddedRule.test(ctx('config/id_rsa', status)),
      ).toHaveLength(0);
    },
  );

  it('does not flag a public key', () => {
    expect(
      secretSensitiveFileAddedRule.test(ctx('config/id_rsa.pub')),
    ).toHaveLength(0);
  });

  it.each([
    'test/fixtures/test-key.pem',
    'certs/example.pem',
    'spec/mock-credentials.json',
    'samples/id_rsa',
  ])('does not flag sample/test material at %s', (path) => {
    expect(secretSensitiveFileAddedRule.test(ctx(path))).toHaveLength(0);
  });

  it.each(['src/main.ts', 'README.md', 'package.json'])(
    'does not flag ordinary file %s',
    (path) => {
      expect(secretSensitiveFileAddedRule.test(ctx(path))).toHaveLength(0);
    },
  );

  // The reason this rule is kind: 'file' — it must reach a verdict with no
  // content whatsoever.
  it('needs no file content to fire', () => {
    const findings = secretSensitiveFileAddedRule.test({
      filePath: 'config/id_rsa',
      language: '*',
      addedLines: [],
      status: 'added',
    });
    expect(findings).toHaveLength(1);
  });
});
