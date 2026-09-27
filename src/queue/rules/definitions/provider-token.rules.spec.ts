import { Rule } from '../rule.interface';
import { FIXTURE_SECRETS } from '../test-helpers';
import { providerTokenRules } from './provider-token.rules';

function ruleById(id: string): Rule {
  const rule = providerTokenRules.find((r) => r.id === id);
  if (!rule) {
    throw new Error(`No provider rule ${id}`);
  }
  return rule;
}

function scan(rule: Rule, text: string) {
  return rule.test({
    filePath: 'src/config.ts',
    language: 'js',
    addedLines: [{ newLine: 4, text }],
  });
}

// Fixture *files* are skipped here: thirteen rules would mean twenty-six
// of them, and these rules read one line with one regex. The fake
// credentials still come from FIXTURE_SECRETS, so no provider-shaped
// string is written literally anywhere in the repo.
describe('provider token rules', () => {
  it.each([
    ['secret.github_fine_grained', 'FAKE_GITHUB_FINE_GRAINED'],
    ['secret.gitlab_runner_token', 'FAKE_GITLAB_RUNNER'],
    ['secret.slack_token', 'FAKE_SLACK_BOT_TOKEN'],
    ['secret.stripe_live', 'FAKE_STRIPE_LIVE'],
    ['secret.google_api_key', 'FAKE_GOOGLE_API_KEY'],
    ['secret.anthropic_key', 'FAKE_ANTHROPIC_KEY'],
    ['secret.openai_key', 'FAKE_OPENAI_KEY'],
    ['secret.sendgrid_key', 'FAKE_SENDGRID_KEY'],
    ['secret.npm_token', 'FAKE_NPM_TOKEN'],
    ['secret.telegram_bot', 'FAKE_TELEGRAM_TOKEN'],
    ['secret.azure_storage_key', 'FAKE_AZURE_KEY'],
    ['secret.discord_webhook', 'FAKE_DISCORD_WEBHOOK'],
  ])('%s flags its own token shape', (id, secretName) => {
    const findings = scan(
      ruleById(id),
      `const t = "${FIXTURE_SECRETS[secretName]}";`,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].snippet).toMatch(/\*\*\*\*$/);
  });

  // The snippet keeps the provider prefix — that is what makes it readable
  // in a review UI — but must never carry enough of the credential to be
  // usable, and never the whole thing.
  it('never puts the full credential in a snippet', () => {
    for (const [id, secretName] of [
      ['secret.github_fine_grained', 'FAKE_GITHUB_FINE_GRAINED'],
      ['secret.stripe_live', 'FAKE_STRIPE_LIVE'],
      ['secret.anthropic_key', 'FAKE_ANTHROPIC_KEY'],
    ] as const) {
      const value = FIXTURE_SECRETS[secretName];
      const snippet = scan(ruleById(id), `token = "${value}"`)[0].snippet!;
      expect(snippet).not.toContain(value);
      expect(snippet.endsWith('****')).toBe(true);
      // Whatever survives redaction is a short prefix, not a usable secret.
      expect(snippet.replace('****', '').length).toBeLessThanOrEqual(24);
    }
  });

  it.each([
    ['secret.github_fine_grained', 'const x = "not a token at all";'],
    ['secret.stripe_live', 'const k = "pk_live_abcdefghijklmnopqrstuv";'],
    ['secret.google_api_key', 'const s = "AIzaTooShort";'],
  ])('%s ignores %s', (id, line) => {
    expect(scan(ruleById(id), line)).toHaveLength(0);
  });

  // Stripe's publishable key is designed to ship to browsers.
  it('does not flag a Stripe publishable key', () => {
    expect(
      scan(ruleById('secret.stripe_live'), 'pk_live_00000000000000000000000'),
    ).toHaveLength(0);
  });

  // SK + 32 hex is a common id shape, so the rule needs the surrounding
  // line to mention Twilio before it means anything.
  describe('secret.twilio_key context requirement', () => {
    const value = FIXTURE_SECRETS.FAKE_TWILIO_KEY;

    it('flags it when the line mentions Twilio', () => {
      expect(
        scan(ruleById('secret.twilio_key'), `twilioApiKey = "${value}"`),
      ).toHaveLength(1);
    });

    it('ignores the same shape without that context', () => {
      expect(
        scan(ruleById('secret.twilio_key'), `sessionId = "${value}"`),
      ).toHaveLength(0);
    });
  });

  // sk-ant- also matches the OpenAI pattern's prefix; the negative
  // lookahead keeps the more accurate rule's message from being shadowed.
  it('does not report an Anthropic key as an OpenAI one', () => {
    const line = `key = "${FIXTURE_SECRETS.FAKE_ANTHROPIC_KEY}"`;
    expect(scan(ruleById('secret.openai_key'), line)).toHaveLength(0);
    expect(scan(ruleById('secret.anthropic_key'), line)).toHaveLength(1);
  });

  it('opts every provider rule out of ValueFilter', () => {
    for (const rule of providerTokenRules) {
      expect(rule.skipValueFilter).toBe(true);
    }
  });
});
