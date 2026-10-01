/* eslint-disable @typescript-eslint/only-throw-error */
import {
  HttpException,
  HttpStatus,
  Injectable,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createAppAuth } from '@octokit/auth-app';
import { request } from '@octokit/request';
import { RequestError } from '@octokit/request-error';

export interface GithubInstallationAccount {
  login: string;
  type: string;
}

export interface GithubInstallation {
  id: number;
  account: GithubInstallationAccount | null;
}

export interface GithubRepository {
  id: number;
  full_name: string;
  private: boolean;
  language: string | null;
}

export interface GithubRepositoryDetail {
  default_branch: string;
}

export interface GithubBranch {
  name: string;
}

export interface GithubPullRequestFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
  previous_filename?: string;
}

const BRANCH_PAGE_SIZE = 100;
const BRANCH_HARD_CAP = 500;
const PR_FILES_PAGE_SIZE = 100;
const PR_FILES_HARD_CAP = 500;
const REQUEST_TIMEOUT_MS = 8000;

// Mints and caches GitHub App installation access tokens, and wraps the
// small set of GitHub API calls this integration needs. Deliberately
// separate from IntegrationsService: that service's private helpers
// (fetchGitlabUser etc.) are shaped around a static admin-pasted token over
// plain HttpService/axios calls, whereas GitHub App auth is a structurally
// different shape — sign a JWT, exchange it for a short-lived installation
// token, let @octokit/auth-app cache/refresh it — that has nothing in
// common with the GitLab HTTP-client shape.
@Injectable()
export class GithubAppService {
  // createAppAuth() must be called exactly once and reused — it owns an
  // internal Lru token cache (TTL 59 minutes, 1 minute under GitHub's 60m
  // expiry) plus in-flight request de-duplication, both scoped to this one
  // `state` closure. Calling createAppAuth() again per-request would
  // silently create a fresh, empty cache every time and defeat the whole
  // point of the caching library (verified by reading
  // node_modules/@octokit/auth-app/dist-src/index.js and
  // get-installation-authentication.js directly before relying on this).
  private readonly appAuth: ReturnType<typeof createAppAuth>;

  constructor(configService: ConfigService) {
    this.appAuth = createAppAuth({
      appId: configService.getOrThrow<string>('githubApp.appId'),
      privateKey: configService.getOrThrow<string>('githubApp.privateKey'),
      clientId: configService.getOrThrow<string>('githubApp.clientId'),
      clientSecret: configService.getOrThrow<string>('githubApp.clientSecret'),
    });
  }

  // Confirms an installation_id from the callback is real and fetches the
  // GitHub org/user it's installed on, authenticated as the App itself
  // (not as any particular installation) — used to verify the callback
  // before trusting it, rather than upserting an Integration row on the
  // query params alone.
  async verifyInstallation(
    installationId: string,
  ): Promise<GithubInstallation> {
    const appAuthentication = await this.appAuth({ type: 'app' });
    try {
      const response = await request(
        'GET /app/installations/{installation_id}',
        {
          installation_id: Number(installationId),
          headers: { authorization: `bearer ${appAuthentication.token}` },
        },
      );
      return response.data as GithubInstallation;
    } catch (error) {
      throw this.mapGithubRequestError(error);
    }
  }

  async listInstallationRepositories(
    installationId: string,
    query?: string,
  ): Promise<GithubRepository[]> {
    const token = await this.getInstallationToken(installationId);
    try {
      const repositories: GithubRepository[] = [];
      let page = 1;

      while (true) {
        const response = await request('GET /installation/repositories', {
          headers: { authorization: `bearer ${token}` },
          per_page: 100,
          page,
        });
        const data = response.data as {
          repositories: GithubRepository[];
        };
        repositories.push(...data.repositories);
        if (data.repositories.length < 100) break;
        page += 1;
      }

      // GitHub's endpoint has no server-side search param the way GitLab's
      // projects list does — filter client-side on full_name when a query
      // is given.
      return query
        ? repositories.filter((repo) =>
            repo.full_name.toLowerCase().includes(query.toLowerCase()),
          )
        : repositories;
    } catch (error) {
      throw this.mapGithubRequestError(error);
    }
  }

  // Default branch snapshot for a single repo (D6, PRD v1.4.2) — never
  // assumed "main", always read live from GitHub at connect/lookup time.
  async fetchRepository(
    installationId: string,
    owner: string,
    repo: string,
  ): Promise<GithubRepositoryDetail> {
    const token = await this.getInstallationToken(installationId);
    try {
      const response = await request('GET /repos/{owner}/{repo}', {
        owner,
        repo,
        headers: { authorization: `bearer ${token}` },
        request: { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
      });
      return response.data;
    } catch (error) {
      throw this.mapGithubRequestError(error);
    }
  }

  // One page of branches (GitHub lists them by name; its API cannot sort
  // by activity). Asks for one more than `limit` to know whether there are
  // more. GitHub's branch API has no search either, so `search` scans up to
  // BRANCH_HARD_CAP names and filters them here (case-insensitive
  // substring) — a repo with more branches than that can miss a match.
  // TODO: GraphQL `refs(query:)` searches every branch server-side.
  async listBranches(
    installationId: string,
    owner: string,
    repo: string,
    options: { limit: number; search?: string },
  ): Promise<{ branches: GithubBranch[]; truncated: boolean }> {
    const token = await this.getInstallationToken(installationId);
    const page = async (perPage: number, pageNumber: number) => {
      const response = await request('GET /repos/{owner}/{repo}/branches', {
        owner,
        repo,
        headers: { authorization: `bearer ${token}` },
        request: { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
        per_page: perPage,
        page: pageNumber,
      });
      return response.data as GithubBranch[];
    };
    try {
      if (!options.search) {
        const data = await page(options.limit + 1, 1);
        return {
          branches: data.slice(0, options.limit),
          truncated: data.length > options.limit,
        };
      }

      const needle = options.search.toLowerCase();
      const matches: GithubBranch[] = [];
      let scanned = 0;
      for (let pageNumber = 1; ; pageNumber += 1) {
        const data = await page(BRANCH_PAGE_SIZE, pageNumber);
        scanned += data.length;
        matches.push(
          ...data.filter((branch) =>
            branch.name.toLowerCase().includes(needle),
          ),
        );
        const exhausted = data.length < BRANCH_PAGE_SIZE;
        if (
          matches.length > options.limit ||
          exhausted ||
          scanned >= BRANCH_HARD_CAP
        ) {
          return {
            branches: matches.slice(0, options.limit),
            truncated: matches.length > options.limit || !exhausted,
          };
        }
      }
    } catch (error) {
      throw this.mapGithubRequestError(error);
    }
  }

  // Whether one branch exists — for validating a user's choice without
  // listing branches. 404 is "no such branch" here, not a bad installation
  // (the repository itself was already resolved by the caller).
  async branchExists(
    installationId: string,
    owner: string,
    repo: string,
    branch: string,
  ): Promise<boolean> {
    const token = await this.getInstallationToken(installationId);
    try {
      await request('GET /repos/{owner}/{repo}/branches/{branch}', {
        owner,
        repo,
        branch,
        headers: { authorization: `bearer ${token}` },
        request: { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
      });
      return true;
    } catch (error) {
      if (error instanceof RequestError && error.status === 404) {
        return false;
      }
      throw this.mapGithubRequestError(error);
    }
  }

  // Paginated per_page=100 until a short page, hard-capped. Files without a `patch`
  // (binary, or too large — GitHub just omits the field, no error) are
  // passed through as-is; PullsService is responsible for turning that
  // absence into an explicit truncated flag for the FE.
  async listPullRequestFiles(
    installationId: string,
    owner: string,
    repo: string,
    pullNumber: string,
  ): Promise<{ files: GithubPullRequestFile[]; truncated: boolean }> {
    const token = await this.getInstallationToken(installationId);
    try {
      const files: GithubPullRequestFile[] = [];
      let page = 1;
      let truncated = false;

      while (true) {
        const response = await request(
          'GET /repos/{owner}/{repo}/pulls/{pull_number}/files',
          {
            owner,
            repo,
            pull_number: Number(pullNumber),
            headers: { authorization: `bearer ${token}` },
            request: { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
            per_page: PR_FILES_PAGE_SIZE,
            page,
          },
        );
        const data = response.data as GithubPullRequestFile[];
        files.push(...data);

        if (files.length >= PR_FILES_HARD_CAP) {
          truncated = true;
          break;
        }
        if (data.length < PR_FILES_PAGE_SIZE) {
          break;
        }
        page += 1;
      }

      return { files: files.slice(0, PR_FILES_HARD_CAP), truncated };
    } catch (error) {
      throw this.mapGithubRequestError(error);
    }
  }

  // Files changed between two commits — the incremental scan's diff (v1.5.1
  // langkah 3). `ancestor` is false when `base` is not an ancestor of
  // `head` (force-push/rebase): GitHub reports `diverged` or `behind`, and
  // the caller falls back to a full scan. GitHub lists at most 300 files.
  async compareCommits(
    installationId: string,
    owner: string,
    repo: string,
    base: string,
    head: string,
  ): Promise<{
    files: GithubPullRequestFile[];
    ancestor: boolean;
    truncated: boolean;
  }> {
    const token = await this.getInstallationToken(installationId);
    try {
      const response = await request(
        'GET /repos/{owner}/{repo}/compare/{basehead}',
        {
          owner,
          repo,
          basehead: `${base}...${head}`,
          headers: { authorization: `bearer ${token}` },
          request: { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
          per_page: PR_FILES_PAGE_SIZE,
        },
      );
      const data = response.data as {
        status: string;
        files?: GithubPullRequestFile[];
      };
      const files = data.files ?? [];
      return {
        files,
        ancestor: data.status === 'ahead' || data.status === 'identical',
        truncated: files.length >= 300,
      };
    } catch (error) {
      throw this.mapGithubRequestError(error);
    }
  }

  // One file at `ref`, as raw text — head-file context for the AI review
  // prompt (v1.5.1 langkah 2). Best effort: null when the file is missing,
  // binary, too large for the contents API, or the call fails; the prompt
  // then falls back to the hunk's own context lines.
  async getFileContent(
    installationId: string,
    owner: string,
    repo: string,
    path: string,
    ref: string,
  ): Promise<string | null> {
    try {
      const token = await this.getInstallationToken(installationId);
      const response = await request(
        'GET /repos/{owner}/{repo}/contents/{path}',
        {
          owner,
          repo,
          path,
          ref,
          headers: {
            authorization: `bearer ${token}`,
            accept: 'application/vnd.github.raw+json',
          },
          request: { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
        },
      );
      return typeof response.data === 'string' ? response.data : null;
    } catch {
      return null;
    }
  }

  private async getInstallationToken(installationId: string): Promise<string> {
    try {
      const installationAuthentication = await this.appAuth({
        type: 'installation',
        installationId: Number(installationId),
      });
      return installationAuthentication.token;
    } catch (error) {
      throw this.mapGithubRequestError(error);
    }
  }

  private mapGithubRequestError(error: unknown): never {
    // AbortSignal.timeout() rejects with a DOMException, not a RequestError
    // — must be checked before the RequestError branch below, or a slow
    // GitHub response would fall through to the generic github_unreachable
    // 422 instead of the more accurate 502 provider_unreachable.
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new HttpException(
        { field: 'installation_id', message: 'provider_unreachable' },
        HttpStatus.BAD_GATEWAY,
      );
    }
    // Octokit throws its own RequestError (from @octokit/request-error),
    // never an axios error — unlike integrations.service.ts's GitLab error
    // mapping, `axios.isAxiosError()` would never match here and every
    // GitHub failure would silently fall through as an unhandled 500,
    // reproducing the exact bug class already hit and fixed on the GitLab
    // side, just for a different HTTP client.
    if (error instanceof RequestError) {
      if (
        error.status === 401 ||
        error.status === 403 ||
        error.status === 404
      ) {
        throw new UnprocessableEntityException({
          field: 'installation_id',
          message: 'installation_invalid',
        });
      }
      throw new UnprocessableEntityException({
        field: 'installation_id',
        message: 'github_unreachable',
      });
    }
    throw error as Error;
  }
}
