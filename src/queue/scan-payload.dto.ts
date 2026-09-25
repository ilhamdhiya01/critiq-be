import { Provider, ScanTrigger } from '../generated/prisma/enums';

// Job payload — ids only, no credentials. The worker re-fetches the
// Integration row (and decrypts its token) from the DB using organizationId/
// repositoryId at process time, never from this payload — see
// ScanProcessor. Keeps the payload small (<2KB) and means a stale/replayed
// job never carries a stale credential.
export interface ScanJobPayload {
  scanId: string;
  organizationId: string;
  repositoryId: string;
  pullId: string;
  headSha: string;
  baseSha: string | null;
  provider: Provider;
  trigger: ScanTrigger;
}
