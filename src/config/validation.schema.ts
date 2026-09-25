import * as Joi from 'joi';

export const validationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),
  DATABASE_URL: Joi.string().required(),
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
  GITLAB_CLIENT_ID: Joi.string().required(),
  GITLAB_CLIENT_SECRET: Joi.string().required(),
  GITLAB_REDIRECT_URL: Joi.string().uri().required(),
  JWT_SECRET: Joi.string().min(32).required(),
  ENCRYPTION_KEY: Joi.string().hex().length(64).required(),
  FE_URL: Joi.string().uri().required(),
  BACKEND_URL: Joi.string().uri().required(),
  REDIS_URL: Joi.string().uri().required(),
  SCAN_CONCURRENCY: Joi.number().default(3),
  SCAN_JOB_TIMEOUT_MS: Joi.number().default(120000),
  SCAN_MAX_DIFF_BYTES: Joi.number().default(1048576),
});
