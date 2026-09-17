// `webhook` deliberately stays `{ status: 'not_configured' }` rather than
// PRD v1.4.2's example `"installed"` — there is no webhook infra yet
// (Fase 4), and claiming "installed" here would be a lie the FE can't
// detect. Kept as an object (not a bare string) so Fase 4 can add fields
// like `installedAt`/`webhookId` without a breaking shape change.
export type CreateReposItemResult =
  | {
      status: 'ok';
      repoId: string;
      path: string;
      defaultBranch: string;
      monitoredBranches: string[];
      webhook: { status: 'not_configured' };
    }
  | {
      status: 'failed';
      providerRepoId: number;
      error: 'provider_unreachable' | 'unknown_branch' | 'already_connected';
      branch?: string;
    };

export class CreateReposResponseDto {
  items!: CreateReposItemResult[];

  constructor(partial: { items: CreateReposItemResult[] }) {
    Object.assign(this, partial);
  }
}
