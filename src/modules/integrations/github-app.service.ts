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
import { ProviderCommentError } from './provider-comment-error';
import { ProviderMergeError } from './provider-merge-error';
import { ProviderReviewError } from './provider-review-error';

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
  // Main language by GitHub's own detection; null when it has none.
  language: string | null;
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
// GET /user/installations, for the installation ownership check.
const USER_INSTALLATIONS_PAGE_SIZE = 100;
const USER_INSTALLATIONS_PAGE_CAP = 10;
// A merge can take GitHub a while on a large repository.
const MERGE_TIMEOUT_MS = 15_000;

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

  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly authorizeRedirectUrl: string;

  constructor(configService: ConfigService) {
    this.clientId = configService.getOrThrow<string>('githubApp.clientId');
    this.clientSecret = configService.getOrThrow<string>(
      'githubApp.clientSecret',
    );
    this.authorizeRedirectUrl = configService.getOrThrow<string>(
      'githubApp.authorizeRedirectUrl',
    );
    this.appAuth = createAppAuth({
      appId: configService.getOrThrow<string>('githubApp.appId'),
      privateKey: configService.getOrThrow<string>('githubApp.privateKey'),
      clientId: this.clientId,
      clientSecret: this.clientSecret,
    });
  }

  // The App's web-flow OAuth page. The Setup URL's installation_id can be
  // spoofed (GitHub's own docs say so), so a callback is only trusted once
  // the user who came back proves, with their own token, that they can
  // see that installation — see userCanAccessInstallation.
  userAuthorizationUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.authorizeRedirectUrl,
      state,
    });
    return `https://github.com/login/oauth/authorize?${params.toString()}`;
  }

  // Exchanges the web-flow `code` for a user token and looks for the
  // installation among the ones that user can access. The token is used
  // for this check only: never stored or logged, and revoked afterwards
  // (best effort — it expires on its own after 8 hours anyway).
  async userCanAccessInstallation(
    code: string,
    installationId: string,
  ): Promise<boolean> {
    let userToken: string;
    try {
      const authentication = await this.appAuth({
        type: 'oauth-user',
        code,
        redirectUrl: this.authorizeRedirectUrl,
      });
      userToken = authentication.token;
    } catch (error) {
      throw this.mapGithubRequestError(error);
    }

    try {
      const wanted = Number(installationId);
      for (let page = 1; page <= USER_INSTALLATIONS_PAGE_CAP; page += 1) {
        const response = await request('GET /user/installations', {
          per_page: USER_INSTALLATIONS_PAGE_SIZE,
          page,
          headers: { authorization: `token ${userToken}` },
          request: { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
        });
        const { installations } = response.data;
        if (installations.some((installation) => installation.id === wanted)) {
          return true;
        }
        if (installations.length < USER_INSTALLATIONS_PAGE_SIZE) {
          return false;
        }
      }
      return false;
    } catch (error) {
      throw this.mapGithubRequestError(error);
    } finally {
      void this.revokeUserToken(userToken);
    }
  }

  private async revokeUserToken(userToken: string): Promise<void> {
    const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString(
      'base64',
    );
    try {
      await request('DELETE /applications/{client_id}/token', {
        client_id: this.clientId,
        access_token: userToken,
        headers: { authorization: `basic ${basic}` },
        request: { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
      });
    } catch {
      // Best effort: the token expires by itself.
    }
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

  // Uninstalls the App from the GitHub account, authenticated as the App.
  // 404 means it is already gone (uninstalled on GitHub first) — the outcome
  // the caller wants, so not an error. Anything else is: the caller must not
  // forget an installation that still has access to the account's code.
  async deleteInstallation(installationId: string): Promise<void> {
    const appAuthentication = await this.appAuth({ type: 'app' });
    try {
      await request('DELETE /app/installations/{installation_id}', {
        installation_id: Number(installationId),
        headers: { authorization: `bearer ${appAuthentication.token}` },
        request: { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
      });
    } catch (error) {
      if (error instanceof RequestError && error.status === 404) {
        return;
      }
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      if (timedOut || error instanceof RequestError) {
        throw new HttpException(
          { field: 'installation_id', message: 'github_unreachable' },
          HttpStatus.BAD_GATEWAY,
        );
      }
      throw error;
    }
  }

  // A review on a pull request as the App (v1.5.2) — shown as the App's
  // bot, with the Critiq reviewer named in `body`. `commitId` pins it to
  // the head the reviewer saw. Needs the App's "Pull requests: write".
  async submitPullReview(
    installationId: string,
    owner: string,
    repo: string,
    pullNumber: string,
    review: {
      commitId: string;
      event: 'APPROVE' | 'REQUEST_CHANGES';
      body: string;
    },
  ): Promise<void> {
    try {
      const token = await this.getInstallationToken(installationId);
      await request('POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews', {
        owner,
        repo,
        pull_number: Number(pullNumber),
        commit_id: review.commitId,
        event: review.event,
        body: review.body,
        headers: { authorization: `bearer ${token}` },
        request: { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
      });
    } catch (error) {
      throw toReviewError(error);
    }
  }

  // Merges a pull request as the App (v1.5.2), pinned to `sha`. Needs the
  // App's "Contents: write". GitHub answers 405 when it is not mergeable
  // (conflicts, required checks or reviews, a method the repo forbids) and
  // 409 when `sha` is no longer the head.
  async mergePullRequest(
    installationId: string,
    owner: string,
    repo: string,
    pullNumber: string,
    merge: { sha: string; method: 'merge' | 'squash' },
  ): Promise<void> {
    try {
      const token = await this.getInstallationToken(installationId);
      await request('PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge', {
        owner,
        repo,
        pull_number: Number(pullNumber),
        sha: merge.sha,
        merge_method: merge.method,
        headers: { authorization: `bearer ${token}` },
        request: { signal: AbortSignal.timeout(MERGE_TIMEOUT_MS) },
      });
    } catch (error) {
      throw toMergeError(error);
    }
  }

  // Best effort after a merge: a branch from a fork, a protected one or one
  // already deleted is left alone — the merge itself has succeeded.
  async deleteBranch(
    installationId: string,
    owner: string,
    repo: string,
    branch: string,
  ): Promise<boolean> {
    try {
      const token = await this.getInstallationToken(installationId);
      await request('DELETE /repos/{owner}/{repo}/git/refs/{ref}', {
        owner,
        repo,
        ref: `heads/${branch}`,
        headers: { authorization: `bearer ${token}` },
        request: { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
      });
      return true;
    } catch {
      return false;
    }
  }

  // A comment in the PR's conversation (v1.5.2), as the App.
  async createIssueComment(
    installationId: string,
    owner: string,
    repo: string,
    pullNumber: string,
    body: string,
  ): Promise<{ id: number }> {
    try {
      const token = await this.getInstallationToken(installationId);
      const response = await request(
        'POST /repos/{owner}/{repo}/issues/{issue_number}/comments',
        {
          owner,
          repo,
          issue_number: Number(pullNumber),
          body,
          headers: { authorization: `bearer ${token}` },
          request: { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
        },
      );
      return { id: (response.data as { id: number }).id };
    } catch (error) {
      throw toCommentError(error);
    }
  }

  // A comment on a line of the diff, starting a thread. `side` RIGHT is the
  // new file, LEFT the old one; GitHub answers 422 for a line outside the
  // diff of `commitId`.
  async createReviewComment(
    installationId: string,
    owner: string,
    repo: string,
    pullNumber: string,
    comment: {
      body: string;
      commitId: string;
      path: string;
      line: number;
      side: 'LEFT' | 'RIGHT';
    },
  ): Promise<{ id: number }> {
    try {
      const token = await this.getInstallationToken(installationId);
      const response = await request(
        'POST /repos/{owner}/{repo}/pulls/{pull_number}/comments',
        {
          owner,
          repo,
          pull_number: Number(pullNumber),
          body: comment.body,
          commit_id: comment.commitId,
          path: comment.path,
          line: comment.line,
          side: comment.side,
          headers: { authorization: `bearer ${token}` },
          request: { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
        },
      );
      return { id: (response.data as { id: number }).id };
    } catch (error) {
      throw toCommentError(error);
    }
  }

  async replyToReviewComment(
    installationId: string,
    owner: string,
    repo: string,
    pullNumber: string,
    rootCommentId: number,
    body: string,
  ): Promise<{ id: number }> {
    try {
      const token = await this.getInstallationToken(installationId);
      const response = await request(
        'POST /repos/{owner}/{repo}/pulls/{pull_number}/comments/{comment_id}/replies',
        {
          owner,
          repo,
          pull_number: Number(pullNumber),
          comment_id: rootCommentId,
          body,
          headers: { authorization: `bearer ${token}` },
          request: { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
        },
      );
      return { id: (response.data as { id: number }).id };
    } catch (error) {
      throw toCommentError(error);
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

// GitHub's answer to a review submission, as a ProviderReviewError: what
// failed decides whether the review-sync queue retries.
function toReviewError(error: unknown): ProviderReviewError {
  if (error instanceof Error && error.name === 'TimeoutError') {
    return new ProviderReviewError('provider_unreachable', true);
  }
  if (error instanceof RequestError) {
    const detail = error.message.slice(0, 200);
    // 404 too: GitHub hides a repository the App cannot see.
    if ([401, 403, 404].includes(error.status)) {
      return new ProviderReviewError('insufficient_permission', false, detail);
    }
    // e.g. "Can not approve your own pull request".
    if (error.status === 422) {
      return new ProviderReviewError('not_allowed', false, detail);
    }
    if (error.status === 429 || error.status >= 500) {
      return new ProviderReviewError('provider_unreachable', true, detail);
    }
    return new ProviderReviewError('unknown', false, detail);
  }
  // getInstallationToken already mapped its own failure.
  if (error instanceof HttpException) {
    const response = error.getResponse() as { message?: unknown };
    return response.message === 'installation_invalid'
      ? new ProviderReviewError('insufficient_permission', false)
      : new ProviderReviewError('provider_unreachable', true);
  }
  return new ProviderReviewError(
    'unknown',
    true,
    error instanceof Error ? error.message.slice(0, 200) : undefined,
  );
}

// GitHub's answer to a merge, as a ProviderMergeError.
function toMergeError(error: unknown): ProviderMergeError {
  if (error instanceof Error && error.name === 'TimeoutError') {
    return new ProviderMergeError('provider_unreachable');
  }
  if (error instanceof RequestError) {
    const detail = error.message.slice(0, 300);
    if (error.status === 409) {
      return new ProviderMergeError('head_changed', detail);
    }
    if (error.status === 405 || error.status === 422) {
      return new ProviderMergeError('not_mergeable', detail);
    }
    if ([401, 403, 404].includes(error.status)) {
      return new ProviderMergeError('insufficient_permission', detail);
    }
    return new ProviderMergeError('provider_unreachable', detail);
  }
  if (error instanceof HttpException) {
    const response = error.getResponse() as { message?: unknown };
    return new ProviderMergeError(
      response.message === 'installation_invalid'
        ? 'insufficient_permission'
        : 'provider_unreachable',
    );
  }
  return new ProviderMergeError(
    'provider_unreachable',
    error instanceof Error ? error.message.slice(0, 300) : undefined,
  );
}

// GitHub's answer to a comment, as a ProviderCommentError.
function toCommentError(error: unknown): ProviderCommentError {
  if (error instanceof Error && error.name === 'TimeoutError') {
    return new ProviderCommentError('provider_unreachable', true);
  }
  if (error instanceof RequestError) {
    const detail = error.message.slice(0, 200);
    if ([401, 403, 404].includes(error.status)) {
      return new ProviderCommentError('insufficient_permission', false, detail);
    }
    // e.g. "pull_request_review_thread.line must be part of the diff".
    if (error.status === 422) {
      return new ProviderCommentError('invalid_position', false, detail);
    }
    if (error.status === 429 || error.status >= 500) {
      return new ProviderCommentError('provider_unreachable', true, detail);
    }
    return new ProviderCommentError('unknown', false, detail);
  }
  if (error instanceof HttpException) {
    const response = error.getResponse() as { message?: unknown };
    return response.message === 'installation_invalid'
      ? new ProviderCommentError('insufficient_permission', false)
      : new ProviderCommentError('provider_unreachable', true);
  }
  return new ProviderCommentError(
    'unknown',
    true,
    error instanceof Error ? error.message.slice(0, 200) : undefined,
  );
}
