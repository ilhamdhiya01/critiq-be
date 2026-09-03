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
    redirectUrl: process.env.REDIRECT_URL,
  },
  feUrl: process.env.FE_URL,
});
