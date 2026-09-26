// Identifiers that merely start with "secret" hold a path or a label, not
// the credential — the bare-`secret` branch must not fire on these.
const secretPath = '/etc/secrets/github-app-private-key.pem';
const secretName = 'projects/1234/secrets/github-webhook-secret';
