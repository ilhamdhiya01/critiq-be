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
    // Identity-only login (PRD v1.4/D3): one fixed OAuth app on gitlab.com,
    // owned by Critiq — not per-instance like v1.3's GitlabInstance. Repo
    // access is a separate, org-level access token submitted via the
    // integrations module, unrelated to this app.
    clientId: process.env.GITLAB_CLIENT_ID,
    clientSecret: process.env.GITLAB_CLIENT_SECRET,
    redirectUrl: process.env.GITLAB_REDIRECT_URL,
  },
  feUrl: process.env.FE_URL,
});
