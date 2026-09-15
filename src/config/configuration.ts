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
    // Identity-only OAuth login App — completely separate credential set
    // from `githubApp` below. Do not confuse the two: this one only proves
    // "who is this person," it has no access to any repo.
    clientId: process.env.GITHUB_CLIENT_ID,
    clientSecret: process.env.GITHUB_CLIENT_SECRET,
    redirectUrl: process.env.GITHUB_REDIRECT_URL,
  },
  githubApp: {
    // Repo access (PRD v1.4/D3, mirrors GitLab's org-level credential
    // principle): a GitHub App installed on the customer's GitHub org,
    // separate from the identity-only OAuth App above. One App, shared
    // across every Critiq organization — not per-org like GitLab's
    // instance URL, since GitHub itself is always api.github.com.
    appId: process.env.GITHUB_APP_ID,
    // Stored in .env as a single line with literal `\n` sequences (real
    // newlines don't survive most .env loaders/shells) — this is the one
    // place that gets unescaped back into a real multi-line PEM string.
    // Everything downstream of this always receives a real PEM, never the
    // escaped form.
    privateKey: process.env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    clientId: process.env.GITHUB_APP_CLIENT_ID,
    clientSecret: process.env.GITHUB_APP_CLIENT_SECRET,
    webhookSecret: process.env.GITHUB_APP_WEBHOOK_SECRET,
    slug: process.env.GITHUB_APP_SLUG,
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
