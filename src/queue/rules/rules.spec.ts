import safeRegex from 'safe-regex2';
import { RULES } from './rules';

describe('RULES', () => {
  it('has no duplicate rule ids', () => {
    const ids = RULES.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('only emits critical severity in this MVP', () => {
    for (const rule of RULES) {
      expect(rule.severity).toBe('critical');
    }
  });

  // An explicit id list rather than a count: a bare toHaveLength(n) drifts
  // with every add and, worse, still passes when one rule is accidentally
  // dropped and another added in the same change.
  it('registers exactly the expected rules', () => {
    expect(RULES.map((rule) => rule.id).sort()).toEqual(
      [
        'code.debugger_left',
        'code.eval_dynamic',
        'code.insecure_tls',
        'code.shell_injection',
        'code.sql_string_concat',
        'config.cors_wildcard_credentials',
        'config.dockerfile_root_secret',
        'secret.assignment_literal',
        'secret.aws_access_key',
        'secret.db_url_with_password',
        'secret.github_token',
        'secret.gitlab_token',
        'secret.hardcoded_password',
        'secret.jwt_literal',
        'secret.private_key_block',
        'secret.sensitive_file_added',
        'secret.slack_webhook',
      ].sort(),
    );
  });

  // Acceptance 26. MAX_LINE_LENGTH caps the input a regex ever sees, but a
  // pattern with genuinely exponential backtracking can still burn a worker
  // slot on 2000 characters — this catches one before it ships. Declaring
  // `patterns` on a rule opts it in, so a rule added later is covered
  // without touching this spec.
  it('uses no regex with catastrophic backtracking', () => {
    for (const rule of RULES) {
      for (const pattern of rule.patterns ?? []) {
        expect({ rule: rule.id, safe: safeRegex(pattern) }).toEqual({
          rule: rule.id,
          safe: true,
        });
      }
    }
  });
});
