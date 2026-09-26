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
        'secret.anthropic_key',
        'secret.assignment_literal',
        'secret.aws_access_key',
        'secret.azure_storage_key',
        'secret.db_url_with_password',
        'secret.discord_webhook',
        'secret.github_fine_grained',
        'secret.github_token',
        'secret.gitlab_runner_token',
        'secret.gitlab_token',
        'secret.google_api_key',
        'secret.hardcoded_password',
        'secret.high_entropy_string',
        'secret.jwt_literal',
        'secret.npm_token',
        'secret.openai_key',
        'secret.private_key_block',
        'secret.sendgrid_key',
        'secret.sensitive_file_added',
        'secret.slack_token',
        'secret.slack_webhook',
        'secret.stripe_live',
        'secret.telegram_bot',
        'secret.twilio_key',
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
