import {
  CredentialKind,
  IntegrationState,
  Provider,
  TokenKind,
} from '../../../generated/prisma/enums';

// Never includes the token itself — only the last 4 characters, matching
// PRD §7's "hanya 4 karakter terakhir yang ditampilkan" rule. The token
// column is write-only from the API's perspective.
export class IntegrationResponseDto {
  source!: Provider;
  instanceUrl!: string;
  credentialKind!: CredentialKind;
  tokenKind!: TokenKind;
  tokenUsername!: string;
  tokenLast4!: string;
  expiresAt!: Date;
  state!: IntegrationState;
  groups!: unknown;

  constructor(partial: {
    source: Provider;
    instanceUrl: string;
    credentialKind: CredentialKind;
    tokenKind: TokenKind;
    tokenUsername: string;
    tokenLast4: string;
    expiresAt: Date;
    state: IntegrationState;
    groups: unknown;
  }) {
    Object.assign(this, partial);
  }
}
