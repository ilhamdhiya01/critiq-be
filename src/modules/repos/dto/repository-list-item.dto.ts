import { Provider } from '../../../generated/prisma/enums';

export class RepositoryListItemDto {
  id!: string;
  provider!: Provider;
  path!: string;
  defaultBranch!: string;
  monitoredBranchCount!: number;

  constructor(partial: {
    id: string;
    provider: Provider;
    path: string;
    defaultBranch: string;
    monitoredBranchCount: number;
  }) {
    Object.assign(this, partial);
  }
}
