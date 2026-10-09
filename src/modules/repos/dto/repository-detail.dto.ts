import { Provider } from '../../../generated/prisma/enums';
import { RepoScanConfigResponseDto } from './repo-scan-config-response.dto';

export class RepositoryDetailDto {
  id!: string;
  provider!: Provider;
  path!: string;
  defaultBranch!: string;
  // Same meaning as on RepositoryListItemDto.
  language!: string | null;
  openPullCount!: number;
  openCriticalCount!: number;
  lastScanAt!: Date | null;
  scanConfig!: RepoScanConfigResponseDto | null;

  constructor(partial: {
    id: string;
    provider: Provider;
    path: string;
    defaultBranch: string;
    language: string | null;
    openPullCount: number;
    openCriticalCount: number;
    lastScanAt: Date | null;
    scanConfig: RepoScanConfigResponseDto | null;
  }) {
    Object.assign(this, partial);
  }
}
