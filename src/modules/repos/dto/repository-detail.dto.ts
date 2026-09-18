import { Provider } from '../../../generated/prisma/enums';
import { RepoScanConfigResponseDto } from './repo-scan-config-response.dto';

export class RepositoryDetailDto {
  id!: string;
  provider!: Provider;
  path!: string;
  defaultBranch!: string;
  scanConfig!: RepoScanConfigResponseDto | null;

  constructor(partial: {
    id: string;
    provider: Provider;
    path: string;
    defaultBranch: string;
    scanConfig: RepoScanConfigResponseDto | null;
  }) {
    Object.assign(this, partial);
  }
}
