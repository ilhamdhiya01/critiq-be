export default () => ({
  nodeEnv: process.env.NODE_ENV ?? 'development',
  database: {
    url: process.env.DATABASE_URL,
  },
  jwt: {
    secret: process.env.JWT_SECRET,
  },
  encryptionKey: process.env.ENCRYPTION_KEY,
  github: {
    clientId: process.env.GITHUB_CLIENT_ID,
    clientSecret: process.env.GITHUB_CLIENT_SECRET,
    redirectUrl: process.env.GITHUB_REDIRECT_URL,
  },
  gitlab: {
    clientId: process.env.GITLAB_CLIENT_ID,
    clientSecret: process.env.GITLAB_CLIENT_SECRET,
    redirectUrl: process.env.GITLAB_REDIRECT_URL,
  },
  feUrl: process.env.FE_URL,
});
