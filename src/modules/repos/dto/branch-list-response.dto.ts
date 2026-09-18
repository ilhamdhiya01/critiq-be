export class BranchListResponseDto {
  defaultBranch!: string;
  branches!: string[];
  total!: number;
  truncated!: boolean;
  fetchedAt!: Date;

  constructor(partial: {
    defaultBranch: string;
    branches: string[];
    total: number;
    truncated: boolean;
    fetchedAt: Date;
  }) {
    Object.assign(this, partial);
  }
}
