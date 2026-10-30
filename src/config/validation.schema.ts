import * as Joi from 'joi';

export const validationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),
  // Console transport threshold (CommonModule). 'info' emits PrismaService's
  // per-query log; 'warn' silences it — what the one-shot CLI scripts use so
  // their output is readable.
  LOG_LEVEL: Joi.string()
    .valid('error', 'warn', 'info', 'debug', 'verbose')
    .default('info'),
  DATABASE_URL: Joi.string().required(),
  SESSION_COOKIE_SAMESITE: Joi.string()
    .valid('lax', 'strict', 'none')
    .optional(),
  GITHUB_CLIENT_ID: Joi.string().required(),
  GITHUB_CLIENT_SECRET: Joi.string().required(),
  GITHUB_REDIRECT_URL: Joi.string().uri().required(),
  GITHUB_APP_ID: Joi.string().required(),
  GITHUB_APP_PRIVATE_KEY: Joi.string().required(),
  GITHUB_APP_CLIENT_ID: Joi.string().required(),
  GITHUB_APP_CLIENT_SECRET: Joi.string().required(),
  // Required: WebhooksController verifies GitHub's X-Hub-Signature-256
  // against this secret on every inbound webhook call — no longer optional
  // now that the receiver endpoint actually exists and depends on it.
  GITHUB_APP_WEBHOOK_SECRET: Joi.string().required(),
  GITHUB_APP_SLUG: Joi.string().required(),
  GITHUB_APP_AUTHORIZE_REDIRECT_URL: Joi.string().uri().allow('').optional(),
  GITLAB_CLIENT_ID: Joi.string().required(),
  GITLAB_CLIENT_SECRET: Joi.string().required(),
  GITLAB_REDIRECT_URL: Joi.string().uri().required(),
  GITLAB_INSTANCE_ALLOWLIST: Joi.string().allow('').optional(),
  JWT_SECRET: Joi.string().min(32).required(),
  ENCRYPTION_KEY: Joi.string().hex().length(64).required(),
  FE_URL: Joi.string().uri().required(),
  BACKEND_URL: Joi.string().uri().required(),
  REDIS_URL: Joi.string().uri().required(),
  SCAN_CONCURRENCY: Joi.number().default(3),
  SCAN_JOB_TIMEOUT_MS: Joi.number().default(120000),
  SCAN_MAX_DIFF_BYTES: Joi.number().default(1048576),
  // Changed files parsed by code.syntax_error per scan (one contents-API
  // fetch each); 0 turns the check off.
  SCAN_SYNTAX_MAX_FILES: Joi.number().integer().min(0).default(50),
  // Comma-separated hostnames, e.g. `vllm.internal,localhost`. Optional:
  // empty means every openai_compatible base URL must be public https.
  AI_COMPAT_HTTP_ALLOWLIST: Joi.string().allow('').optional(),
  AI_CONCURRENCY: Joi.number().integer().min(1).default(2),
  AI_MAX_INPUT_TOKENS: Joi.number().integer().min(1000).default(60000),
  AI_MAX_OUTPUT_TOKENS: Joi.number().integer().min(256).default(32000),
  AI_TIMEOUT_MS: Joi.number().integer().min(1000).default(300000),
  AI_CONTEXT_LINES: Joi.number().integer().min(0).default(30),
  AI_MAX_DIFF_BYTES: Joi.number().integer().min(1024).default(204800),
  AI_KEEP_DEDUPED: Joi.boolean().default(false),
  // Unlocks the detailed GET /health (queue counts, workers, AI orgs).
  // Empty: only the overall status is ever shown.
  HEALTH_TOKEN: Joi.string().allow('').optional(),
  // Invitation emails. All optional: without SMTP_HOST invitations are still
  // created and the Admin shares the link. Credentials only ever come from
  // the environment.
  SMTP_HOST: Joi.string().hostname().allow('').optional(),
  SMTP_PORT: Joi.number().integer().min(1).max(65535).default(465),
  SMTP_SECURE: Joi.boolean().default(true),
  SMTP_USER: Joi.string().allow('').optional(),
  SMTP_PASS: Joi.string().allow('').optional(),
  MAIL_FROM: Joi.string().allow('').optional(),
});
