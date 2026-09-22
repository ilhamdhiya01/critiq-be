export class PullRequestFileDto {
  path!: string;
  previousPath!: string | null;
  status!: 'added' | 'removed' | 'modified' | 'renamed';
  additions!: number | null;
  deletions!: number | null;
  patch!: string | null;
  truncated!: boolean;

  constructor(partial: {
    path: string;
    previousPath: string | null;
    status: 'added' | 'removed' | 'modified' | 'renamed';
    additions: number | null;
    deletions: number | null;
    patch: string | null;
    truncated: boolean;
  }) {
    Object.assign(this, partial);
  }
}

export class PullRequestDiffDto {
  files!: PullRequestFileDto[];
  truncated!: boolean;

  constructor(partial: { files: PullRequestFileDto[]; truncated: boolean }) {
    Object.assign(this, partial);
  }
}
