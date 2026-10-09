import { Provider } from '../../../generated/prisma/enums';

export class RepositoryListItemDto {
  id!: string;
  provider!: Provider;
  path!: string;
  defaultBranch!: string;
  monitoredBranchCount!: number;
  // Main language from the provider; null when unknown or not asked yet.
  language!: string | null;
  openPullCount!: number;
  // Active criticals in the latest scan of each open PR. Not a quality
  // gate — that also needs CI status (v1.5.3).
  openCriticalCount!: number;
  lastScanAt!: Date | null;

  constructor(partial: {
    id: string;
    provider: Provider;
    path: string;
    defaultBranch: string;
    monitoredBranchCount: number;
    language: string | null;
    openPullCount: number;
    openCriticalCount: number;
    lastScanAt: Date | null;
  }) {
    Object.assign(this, partial);
  }
}
