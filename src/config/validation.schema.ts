import * as Joi from 'joi';

export const validationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),
  DATABASE_URL: Joi.string().required(),
  GITHUB_CLIENT_ID: Joi.string().required(),
  GITHUB_CLIENT_SECRET: Joi.string().required(),
  GITHUB_REDIRECT_URL: Joi.string().uri().required(),
  GITLAB_CLIENT_ID: Joi.string().required(),
  GITLAB_CLIENT_SECRET: Joi.string().required(),
  GITLAB_REDIRECT_URL: Joi.string().uri().required(),
  JWT_SECRET: Joi.string().min(32).required(),
  ENCRYPTION_KEY: Joi.string().hex().length(64).required(),
  FE_URL: Joi.string().uri().required(),
});
