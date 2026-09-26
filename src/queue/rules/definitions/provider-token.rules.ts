import { Rule, RuleFinding } from '../rule.interface';

// Credentials that announce themselves with a fixed prefix issued by the
// provider: `ghp_`, `AKIA`, `sk-ant-`. There is nothing to interpret — a
// string in that shape either is one of those tokens or is a deliberate
// imitation of one, so these rules skip ValueFilter entirely.
//
// That exemption is why AWS's own published example key
// (AKIAIOSFODNN7EXAMPLE) still reports: the filter would throw it away for
// containing the word EXAMPLE, and a key in a real repo is worth flagging
// whatever it spells.
//
// They share one shape — one regex, one line, a four-character snippet — so
// they are built from a factory rather than copied into fourteen files that
// would then drift apart.
interface ProviderTokenSpec {
  id: string;
  title: string;
  message: string;
  pattern: RegExp;
  // How much of the match to keep in the snippet. Longer where the prefix
  // itself is the informative part (`github_pat_` is 11 characters).
  prefixLength?: number;
  // Only report when the line also contains this, case-insensitively. For
  // patterns loose enough to collide with ordinary hex or ids, the
  // surrounding context is what makes the match meaningful.
  requiresLineContains?: string;
}

const DEFAULT_PREFIX_LENGTH = 4;

function providerTokenRule(spec: ProviderTokenSpec): Rule {
  const prefixLength = spec.prefixLength ?? DEFAULT_PREFIX_LENGTH;
  return {
    id: spec.id,
    severity: 'critical',
    title: spec.title,
    message: spec.message,
    languages: '*',
    skipValueFilter: true,
    patterns: [spec.pattern],
    test(ctx) {
      const findings: RuleFinding[] = [];
      for (const line of ctx.addedLines) {
        if (
          spec.requiresLineContains &&
          !line.text
            .toLowerCase()
            .includes(spec.requiresLineContains.toLowerCase())
        ) {
          continue;
        }
        const match = spec.pattern.exec(line.text);
        if (match) {
          findings.push({
            lineStart: line.newLine,
            lineEnd: line.newLine,
            snippet: match[0].slice(0, prefixLength) + '****',
          });
        }
      }
      return findings;
    },
  };
}

const ROTATE = (what: string, where: string) =>
  `This looks like ${what}. Revoke it in ${where} and rotate immediately — a credential committed to git must be treated as compromised, even if the commit is reverted.`;

export const providerTokenRules: Rule[] = [
  providerTokenRule({
    id: 'secret.github_fine_grained',
    title: 'GitHub fine-grained token committed',
    message: ROTATE(
      'a GitHub fine-grained personal access token',
      'GitHub settings',
    ),
    pattern: /github_pat_[A-Za-z0-9_]{82}/,
    prefixLength: 11,
  }),
  providerTokenRule({
    id: 'secret.gitlab_runner_token',
    title: 'GitLab runner token committed',
    message: ROTATE(
      'a GitLab runner authentication token',
      'GitLab CI/CD settings',
    ),
    pattern: /glrt-[A-Za-z0-9_-]{20,}/,
    prefixLength: 5,
  }),
  providerTokenRule({
    id: 'secret.slack_token',
    title: 'Slack token committed',
    message: ROTATE('a Slack API token', 'your Slack app settings'),
    pattern: /xox[abprs]-[A-Za-z0-9-]{10,}/,
    prefixLength: 5,
  }),
  providerTokenRule({
    id: 'secret.stripe_live',
    title: 'Stripe live key committed',
    message: ROTATE('a Stripe live secret key', 'the Stripe dashboard'),
    // Only sk_/rk_ — pk_live_ is the publishable key and is meant to ship
    // to browsers.
    pattern: /(?:sk|rk)_live_[A-Za-z0-9]{20,}/,
    prefixLength: 8,
  }),
  providerTokenRule({
    id: 'secret.google_api_key',
    title: 'Google API key committed',
    message: ROTATE('a Google API key', 'the Google Cloud console'),
    pattern: /AIza[0-9A-Za-z_-]{35}/,
  }),
  providerTokenRule({
    id: 'secret.anthropic_key',
    title: 'Anthropic API key committed',
    message: ROTATE('an Anthropic API key', 'the Anthropic console'),
    pattern: /sk-ant-[A-Za-z0-9_-]{20,}/,
    prefixLength: 7,
  }),
  providerTokenRule({
    id: 'secret.openai_key',
    title: 'OpenAI API key committed',
    message: ROTATE('an OpenAI API key', 'the OpenAI dashboard'),
    // `(?!ant-)` keeps this from also matching sk-ant-… , which
    // secret.anthropic_key reports with a more accurate message.
    pattern: /sk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{20,}/,
    prefixLength: 3,
  }),
  providerTokenRule({
    id: 'secret.sendgrid_key',
    title: 'SendGrid API key committed',
    message: ROTATE('a SendGrid API key', 'the SendGrid dashboard'),
    pattern: /SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/,
    prefixLength: 3,
  }),
  providerTokenRule({
    id: 'secret.twilio_key',
    title: 'Twilio API key committed',
    message: ROTATE('a Twilio API key SID', 'the Twilio console'),
    // SK + 32 hex is too generic on its own — plenty of ids look like that
    // — so the line has to mention Twilio for the match to mean anything.
    pattern: /SK[0-9a-f]{32}/,
    requiresLineContains: 'twilio',
  }),
  providerTokenRule({
    id: 'secret.npm_token',
    title: 'npm token committed',
    message: ROTATE('an npm access token', 'your npm account settings'),
    pattern: /npm_[A-Za-z0-9]{36}/,
  }),
  providerTokenRule({
    id: 'secret.telegram_bot',
    title: 'Telegram bot token committed',
    message: ROTATE('a Telegram bot token', 'BotFather'),
    pattern: /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/,
    prefixLength: 6,
  }),
  providerTokenRule({
    id: 'secret.azure_storage_key',
    title: 'Azure storage key committed',
    message: ROTATE('an Azure Storage account key', 'the Azure portal'),
    pattern: /AccountKey=[A-Za-z0-9+/=]{86,}/,
    prefixLength: 11,
  }),
  providerTokenRule({
    id: 'secret.discord_webhook',
    title: 'Discord webhook committed',
    message: ROTATE(
      'a Discord webhook URL, which lets anyone post to that channel',
      'the channel’s integration settings',
    ),
    pattern:
      /https:\/\/discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]{60,}/,
    prefixLength: 24,
  }),
];
