// `webhook` reflects what actually happened in createRepos(), not a
// hardcoded PRD example value:
//  - 'installed' — GitLab only: ReposService called the GitLab API and it
//    succeeded (Repository.gitlabWebhookId is set).
//  - 'app_managed' — GitHub only: there is no per-repo install step at all
//    (GitHub App webhooks are configured once, App-wide, in the App's own
//    dashboard), so this repo's events already flow the moment the App was
//    granted access to it — distinct from 'installed' so the FE never
//    implies a retry action exists for GitHub repos.
//  - 'failed' — GitLab only: the repo/RepoScanConfig/BranchScanPolicy rows
//    still committed (status stays 'ok' at the outer level — see
//    ReposService.createRepos), only the hook registration call itself
//    failed. No retry endpoint exists yet; this is surfaced so the FE can
//    at least warn the admin the repo won't scan automatically.
export type CreateReposItemResult =
  | {
      status: 'ok';
      repoId: string;
      path: string;
      defaultBranch: string;
      monitoredBranches: string[];
      webhook:
        | { status: 'installed' }
        | { status: 'app_managed' }
        | { status: 'failed'; error: string };
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
