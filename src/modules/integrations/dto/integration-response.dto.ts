import {
  CredentialKind,
  IntegrationState,
  Provider,
  TokenKind,
} from '../../../generated/prisma/enums';

// Never includes a token/secret itself — GitLab: only the last 4 characters
// of the token (PRD §7's "hanya 4 karakter terakhir yang ditampilkan" rule).
// GitHub: there is no per-row secret at all (the installation id is not
// sensitive on its own — the shared App private key is what's sensitive,
// and that never leaves server config). Fields are split per-source; a
// GITLAB row leaves the GitHub-only fields null and vice versa.
export class IntegrationResponseDto {
  source!: Provider;
  credentialKind!: CredentialKind;
  state!: IntegrationState;

  // GitLab-only
  instanceUrl!: string | null;
  tokenKind!: TokenKind | null;
  tokenUsername!: string | null;
  tokenLast4!: string | null;
  expiresAt!: Date | null;
  groups!: unknown;

  // GitHub-only
  installationId!: string | null;
  installationLogin!: string | null;
  appSlug!: string | null;

  constructor(partial: {
    source: Provider;
    credentialKind: CredentialKind;
    state: IntegrationState;
    instanceUrl: string | null;
    tokenKind: TokenKind | null;
    tokenUsername: string | null;
    tokenLast4: string | null;
    expiresAt: Date | null;
    groups: unknown;
    installationId: string | null;
    installationLogin: string | null;
    appSlug: string | null;
  }) {
    Object.assign(this, partial);
  }
}
