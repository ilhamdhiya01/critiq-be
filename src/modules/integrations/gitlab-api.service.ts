/* eslint-disable @typescript-eslint/only-throw-error */
import {
  HttpException,
  HttpStatus,
  Injectable,
  UnprocessableEntityException,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import axios from 'axios';
import { ProviderCommentError } from './provider-comment-error';
import { ProviderMergeError } from './provider-merge-error';
import { ProviderReviewError } from './provider-review-error';

export interface GitlabUser {
  id: number;
  username: string;
}

export interface GitlabPersonalAccessTokenSelf {
  scopes: string[];
  expires_at: string | null;
}

export interface GitlabProject {
  id: number;
  path_with_namespace: string;
  // GitLab omits this field entirely for some project types/permissions
  // rather than returning null, so it's optional here, not nullable.
  language?: string;
  visibility: string;
  permissions?: {
    project_access?: { access_level: number } | null;
    group_access?: { access_level: number } | null;
  };
}

export interface GitlabProjectDetail {
  id: number;
  path_with_namespace: string;
  default_branch: string;
}

export interface GitlabBranch {
  name: string;
}

export interface GitlabDiffRefs {
  base_sha: string;
  start_sha: string;
  head_sha: string;
}

// An inline note's place in the diff: new_line for an added or unchanged
// line on the new side, old_line for a removed one.
export interface GitlabNotePosition extends GitlabDiffRefs {
  position_type: 'text';
  old_path: string;
  new_path: string;
  new_line?: number;
  old_line?: number;
}

export interface GitlabProjectHook {
  id: number;
}

export interface GitlabMergeRequestDiff {
  old_path: string;
  new_path: string;
  new_file: boolean;
  renamed_file: boolean;
  deleted_file: boolean;
  diff: string;
  too_large?: boolean;
}

const MAINTAINER_ACCESS_LEVEL = 40;
const REQUEST_TIMEOUT_MS = 8000;
// A merge can take GitLab a while on a large project.
const MERGE_TIMEOUT_MS = 15_000;
const MR_DIFFS_PAGE_SIZE = 100;
const MR_DIFFS_HARD_CAP = 500;

// All GitLab REST API access (credential verification for Fase 2's identity
// login gate, and now repo/branch lookups for the `repos` module) lives
// here — extracted out of IntegrationsService (PRD v1.4.2 planning) so
// ReposService can call GitLab directly without depending on the
// integrations module's connect/disconnect responsibilities, and so there
// is exactly one place mapGitlabRequestError can diverge from, not two.
@Injectable()
export class GitlabApiService {
  constructor(private readonly http: HttpService) {}

  async fetchUser(instanceUrl: string, token: string): Promise<GitlabUser> {
    try {
      const response = await firstValueFrom(
        this.http.get<GitlabUser>(`${instanceUrl}/api/v4/user`, {
          headers: { 'Private-Token': token },
          timeout: REQUEST_TIMEOUT_MS,
        }),
      );
      return response.data;
    } catch (error) {
      throw this.mapGitlabRequestError(error);
    }
  }

  async fetchTokenSelf(
    instanceUrl: string,
    token: string,
  ): Promise<GitlabPersonalAccessTokenSelf> {
    try {
      const response = await firstValueFrom(
        this.http.get<GitlabPersonalAccessTokenSelf>(
          `${instanceUrl}/api/v4/personal_access_tokens/self`,
          { headers: { 'Private-Token': token }, timeout: REQUEST_TIMEOUT_MS },
        ),
      );
      return response.data;
    } catch (error) {
      throw this.mapGitlabRequestError(error);
    }
  }

  async fetchMaintainerProjects(
    instanceUrl: string,
    token: string,
    search?: string,
  ): Promise<GitlabProject[]> {
    try {
      const response = await firstValueFrom(
        this.http.get<GitlabProject[]>(`${instanceUrl}/api/v4/projects`, {
          headers: { 'Private-Token': token },
          timeout: REQUEST_TIMEOUT_MS,
          params: {
            membership: true,
            min_access_level: MAINTAINER_ACCESS_LEVEL,
            ...(search && { search }),
          },
        }),
      );
      return response.data;
    } catch (error) {
      throw this.mapGitlabRequestError(error);
    }
  }

  async fetchProject(
    instanceUrl: string,
    token: string,
    projectId: string,
  ): Promise<GitlabProjectDetail> {
    try {
      const response = await firstValueFrom(
        this.http.get<GitlabProjectDetail>(
          `${instanceUrl}/api/v4/projects/${encodeURIComponent(projectId)}`,
          { headers: { 'Private-Token': token }, timeout: REQUEST_TIMEOUT_MS },
        ),
      );
      return response.data;
    } catch (error) {
      throw this.mapGitlabRequestError(error);
    }
  }

  // The project's main language — GitLab's project detail has none; its
  // languages endpoint returns { name: percentage }. Display only, so best
  // effort: any failure is null, never an error for the caller.
  async fetchMainLanguage(
    instanceUrl: string,
    token: string,
    projectId: string,
  ): Promise<string | null> {
    try {
      const response = await firstValueFrom(
        this.http.get<Record<string, number>>(
          `${instanceUrl}/api/v4/projects/${encodeURIComponent(projectId)}/languages`,
          { headers: { 'Private-Token': token }, timeout: REQUEST_TIMEOUT_MS },
        ),
      );
      const ranked = Object.entries(response.data ?? {}).sort(
        ([, a], [, b]) => b - a,
      );
      return ranked[0]?.[0] ?? null;
    } catch {
      return null;
    }
  }

  // One page of branches, most recently updated first — a repo with
  // hundreds of issue branches listed by name showed the user 500 stale
  // ones and none of the active. `search` is GitLab's own filter across
  // every branch of the project (substring; `^term` / `term$` anchor).
  // Asks for one more than `limit` to know whether there are more without
  // relying on pagination headers.
  async fetchBranches(
    instanceUrl: string,
    token: string,
    projectId: string,
    options: { limit: number; search?: string },
  ): Promise<{ branches: GitlabBranch[]; truncated: boolean }> {
    try {
      const response = await firstValueFrom(
        this.http.get<GitlabBranch[]>(
          `${instanceUrl}/api/v4/projects/${encodeURIComponent(projectId)}/repository/branches`,
          {
            headers: { 'Private-Token': token },
            timeout: REQUEST_TIMEOUT_MS,
            params: {
              per_page: options.limit + 1,
              sort: 'updated_desc',
              ...(options.search && { search: options.search }),
            },
          },
        ),
      );
      return {
        branches: response.data.slice(0, options.limit),
        truncated: response.data.length > options.limit,
      };
    } catch (error) {
      throw this.mapGitlabRequestError(error);
    }
  }

  // Whether one branch exists — for validating a user's choice without
  // listing branches (a picked branch may be far outside any listed page).
  async branchExists(
    instanceUrl: string,
    token: string,
    projectId: string,
    branch: string,
  ): Promise<boolean> {
    try {
      await firstValueFrom(
        this.http.get(
          `${instanceUrl}/api/v4/projects/${encodeURIComponent(projectId)}/repository/branches/${encodeURIComponent(branch)}`,
          { headers: { 'Private-Token': token }, timeout: REQUEST_TIMEOUT_MS },
        ),
      );
      return true;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        return false;
      }
      throw this.mapGitlabRequestError(error);
    }
  }

  // Uses the current `/diffs` endpoint (paginated), not the deprecated
  // `/changes` endpoint (unpaginated, flagged for removal by GitLab) —
  // paginated per_page=100 until a short page, hard-capped. `diff` comes back as an
  // empty string for binary files or when `too_large` is set; PullsService
  // is responsible for turning that into an explicit truncated flag.
  async fetchMergeRequestDiffs(
    instanceUrl: string,
    token: string,
    projectId: string,
    mergeIid: string,
  ): Promise<{ diffs: GitlabMergeRequestDiff[]; truncated: boolean }> {
    const diffs: GitlabMergeRequestDiff[] = [];
    let page = 1;
    let truncated = false;

    while (true) {
      let response: { data: GitlabMergeRequestDiff[] };
      try {
        response = await firstValueFrom(
          this.http.get<GitlabMergeRequestDiff[]>(
            `${instanceUrl}/api/v4/projects/${encodeURIComponent(projectId)}/merge_requests/${encodeURIComponent(mergeIid)}/diffs`,
            {
              headers: { 'Private-Token': token },
              timeout: REQUEST_TIMEOUT_MS,
              params: { per_page: MR_DIFFS_PAGE_SIZE, page },
            },
          ),
        );
      } catch (error) {
        throw this.mapGitlabRequestError(error);
      }

      diffs.push(...response.data);

      if (diffs.length >= MR_DIFFS_HARD_CAP) {
        truncated = true;
        break;
      }
      if (response.data.length < MR_DIFFS_PAGE_SIZE) {
        break;
      }
      page += 1;
    }

    return { diffs: diffs.slice(0, MR_DIFFS_HARD_CAP), truncated };
  }

  // Diff between two commits — the incremental scan's diff (v1.5.1 langkah
  // 3) — plus whether `from` is an ancestor of `to`, via the merge base: a
  // force-push/rebase makes them diverge and the caller scans in full.
  async compareCommits(
    instanceUrl: string,
    token: string,
    projectId: string,
    from: string,
    to: string,
  ): Promise<{ diffs: GitlabMergeRequestDiff[]; ancestor: boolean }> {
    const base = `${instanceUrl}/api/v4/projects/${encodeURIComponent(projectId)}/repository`;
    try {
      const [compare, mergeBase] = await Promise.all([
        firstValueFrom(
          this.http.get<{ diffs?: GitlabMergeRequestDiff[] }>(
            `${base}/compare`,
            {
              headers: { 'Private-Token': token },
              timeout: REQUEST_TIMEOUT_MS,
              params: { from, to, straight: false },
            },
          ),
        ),
        firstValueFrom(
          this.http.get<{ id: string }>(`${base}/merge_base`, {
            headers: { 'Private-Token': token },
            timeout: REQUEST_TIMEOUT_MS,
            // GitLab wants `refs[]=A&refs[]=B`. axios drops a `[]` suffix
            // from the key itself, so `{ 'refs[]': … }` went out as
            // `refs=A&refs=B` — a 400 "Provide at least 2 refs" that failed
            // every incremental GitLab scan. `indexes: false` adds the `[]`.
            params: { refs: [from, to] },
            paramsSerializer: { indexes: false },
          }),
        ),
      ]);
      return {
        diffs: compare.data.diffs ?? [],
        ancestor: mergeBase.data.id === from,
      };
    } catch (error) {
      throw this.mapGitlabRequestError(error);
    }
  }

  // One file at `ref`, as raw text — head-file context for the AI review
  // prompt (v1.5.1 langkah 2). Best effort: null on any failure; the prompt
  // falls back to the hunk's own context lines.
  async fetchRawFile(
    instanceUrl: string,
    token: string,
    projectId: string,
    path: string,
    ref: string,
  ): Promise<string | null> {
    try {
      const response = await firstValueFrom(
        this.http.get<string>(
          `${instanceUrl}/api/v4/projects/${encodeURIComponent(projectId)}/repository/files/${encodeURIComponent(path)}/raw`,
          {
            headers: { 'Private-Token': token },
            timeout: REQUEST_TIMEOUT_MS,
            params: { ref },
            responseType: 'text',
            transformResponse: (data: unknown) => data,
          },
        ),
      );
      return typeof response.data === 'string' ? response.data : null;
    } catch {
      return null;
    }
  }

  // Registers a webhook on a single project (D6/webhook rollout — called
  // from ReposService.createRepos after a repo's Repository row commits).
  // GitLab returns the created hook's `id`, which the caller persists on
  // Repository.gitlabWebhookId so it can be deleted again on disconnect.
  async createProjectHook(
    instanceUrl: string,
    token: string,
    projectId: string,
    opts: { url: string; secretToken: string },
  ): Promise<GitlabProjectHook> {
    try {
      const response = await firstValueFrom(
        this.http.post<GitlabProjectHook>(
          `${instanceUrl}/api/v4/projects/${encodeURIComponent(projectId)}/hooks`,
          {
            url: opts.url,
            token: opts.secretToken,
            merge_requests_events: true,
            // Comments written on GitLab, for the two-way comment sync.
            note_events: true,
            push_events: false,
            enable_ssl_verification: true,
          },
          { headers: { 'Private-Token': token }, timeout: REQUEST_TIMEOUT_MS },
        ),
      );
      return response.data;
    } catch (error) {
      throw this.mapGitlabRequestError(error);
    }
  }

  // Approves an MR as the org token's user (v1.5.2), pinned to `sha` — GitLab
  // answers 409 when it is no longer the head. 401 means this user may not
  // approve, or already did: an approval that is already there is the
  // outcome asked for, so that case succeeds.
  async approveMergeRequest(
    instanceUrl: string,
    token: string,
    projectId: string,
    mergeRequestIid: string,
    sha: string,
  ): Promise<void> {
    const base = this.mergeRequestUrl(instanceUrl, projectId, mergeRequestIid);
    try {
      await firstValueFrom(
        this.http.post(
          `${base}/approve`,
          { sha },
          { headers: { 'Private-Token': token }, timeout: REQUEST_TIMEOUT_MS },
        ),
      );
    } catch (error) {
      if (
        axios.isAxiosError(error) &&
        error.response?.status === 401 &&
        (await this.hasApproved(base, token))
      ) {
        return;
      }
      throw toReviewError(error);
    }
  }

  // Withdraws the org token user's approval — how "request changes" lands
  // on GitLab, with a note giving the reason. 404: it had not approved.
  async unapproveMergeRequest(
    instanceUrl: string,
    token: string,
    projectId: string,
    mergeRequestIid: string,
  ): Promise<void> {
    const base = this.mergeRequestUrl(instanceUrl, projectId, mergeRequestIid);
    try {
      await firstValueFrom(
        this.http.post(
          `${base}/unapprove`,
          {},
          { headers: { 'Private-Token': token }, timeout: REQUEST_TIMEOUT_MS },
        ),
      );
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        return;
      }
      throw toReviewError(error);
    }
  }

  async createMergeRequestNote(
    instanceUrl: string,
    token: string,
    projectId: string,
    mergeRequestIid: string,
    body: string,
  ): Promise<void> {
    const base = this.mergeRequestUrl(instanceUrl, projectId, mergeRequestIid);
    try {
      await firstValueFrom(
        this.http.post(
          `${base}/notes`,
          { body },
          { headers: { 'Private-Token': token }, timeout: REQUEST_TIMEOUT_MS },
        ),
      );
    } catch (error) {
      throw toReviewError(error);
    }
  }

  // Merges an MR as the org token's user (v1.5.2), pinned to `sha`. GitLab
  // answers 405/406 when it cannot merge (draft, conflicts, pipeline or
  // approvals required, discussions open) and 409 when `sha` is no longer
  // the head.
  async mergeMergeRequest(
    instanceUrl: string,
    token: string,
    projectId: string,
    mergeRequestIid: string,
    merge: { sha: string; squash: boolean; removeSourceBranch: boolean },
  ): Promise<void> {
    const base = this.mergeRequestUrl(instanceUrl, projectId, mergeRequestIid);
    try {
      await firstValueFrom(
        this.http.put(
          `${base}/merge`,
          {
            sha: merge.sha,
            squash: merge.squash,
            should_remove_source_branch: merge.removeSourceBranch,
          },
          { headers: { 'Private-Token': token }, timeout: MERGE_TIMEOUT_MS },
        ),
      );
    } catch (error) {
      throw toMergeError(error);
    }
  }

  // The shas an inline comment's position must name (v1.5.2).
  async fetchMergeRequestDiffRefs(
    instanceUrl: string,
    token: string,
    projectId: string,
    mergeRequestIid: string,
  ): Promise<GitlabDiffRefs> {
    const base = this.mergeRequestUrl(instanceUrl, projectId, mergeRequestIid);
    try {
      const response = await firstValueFrom(
        this.http.get<{ diff_refs: GitlabDiffRefs | null }>(base, {
          headers: { 'Private-Token': token },
          timeout: REQUEST_TIMEOUT_MS,
        }),
      );
      if (!response.data.diff_refs) {
        throw new ProviderCommentError(
          'provider_unreachable',
          true,
          'no diff_refs',
        );
      }
      return response.data.diff_refs;
    } catch (error) {
      throw toCommentError(error);
    }
  }

  // Starts a discussion on the MR: a general one, or an inline one when
  // `position` is given. Returns the discussion and its first note.
  async createDiscussion(
    instanceUrl: string,
    token: string,
    projectId: string,
    mergeRequestIid: string,
    body: string,
    position?: GitlabNotePosition,
  ): Promise<{ discussionId: string; noteId: number }> {
    const base = this.mergeRequestUrl(instanceUrl, projectId, mergeRequestIid);
    try {
      const response = await firstValueFrom(
        this.http.post<{ id: string; notes: { id: number }[] }>(
          `${base}/discussions`,
          position ? { body, position } : { body },
          { headers: { 'Private-Token': token }, timeout: REQUEST_TIMEOUT_MS },
        ),
      );
      return {
        discussionId: response.data.id,
        noteId: response.data.notes[0]?.id,
      };
    } catch (error) {
      throw toCommentError(error);
    }
  }

  async addDiscussionNote(
    instanceUrl: string,
    token: string,
    projectId: string,
    mergeRequestIid: string,
    discussionId: string,
    body: string,
  ): Promise<{ noteId: number }> {
    const base = this.mergeRequestUrl(instanceUrl, projectId, mergeRequestIid);
    try {
      const response = await firstValueFrom(
        this.http.post<{ id: number }>(
          `${base}/discussions/${encodeURIComponent(discussionId)}/notes`,
          { body },
          { headers: { 'Private-Token': token }, timeout: REQUEST_TIMEOUT_MS },
        ),
      );
      return { noteId: response.data.id };
    } catch (error) {
      throw toCommentError(error);
    }
  }

  // Whether the token's user has approved the MR. Unknown (the approvals
  // state cannot be read) counts as no.
  private async hasApproved(base: string, token: string): Promise<boolean> {
    try {
      const response = await firstValueFrom(
        this.http.get<{ user_has_approved?: boolean }>(`${base}/approvals`, {
          headers: { 'Private-Token': token },
          timeout: REQUEST_TIMEOUT_MS,
        }),
      );
      return response.data.user_has_approved === true;
    } catch {
      return false;
    }
  }

  private mergeRequestUrl(
    instanceUrl: string,
    projectId: string,
    mergeRequestIid: string,
  ): string {
    return `${instanceUrl}/api/v4/projects/${encodeURIComponent(projectId)}/merge_requests/${encodeURIComponent(mergeRequestIid)}`;
  }

  // Brings a hook created before the comment sync up to date, keeping its
  // secret token (omitted fields stay as they are). GitLab requires `url`
  // on every edit.
  async enableNoteEvents(
    instanceUrl: string,
    token: string,
    projectId: string,
    hookId: number,
    url: string,
  ): Promise<void> {
    try {
      await firstValueFrom(
        this.http.put(
          `${instanceUrl}/api/v4/projects/${encodeURIComponent(projectId)}/hooks/${hookId}`,
          {
            url,
            merge_requests_events: true,
            note_events: true,
            push_events: false,
          },
          { headers: { 'Private-Token': token }, timeout: REQUEST_TIMEOUT_MS },
        ),
      );
    } catch (error) {
      throw this.mapGitlabRequestError(error);
    }
  }

  // Called from IntegrationsService.disconnectGitlab when revoking every
  // repo's hook before deleting the Integration row. A 404 here means the
  // hook is already gone (e.g. deleted manually on GitLab's side) — treated
  // as success rather than an error, since the caller's goal ("this hook
  // should not exist") is already satisfied.
  async deleteProjectHook(
    instanceUrl: string,
    token: string,
    projectId: string,
    hookId: number,
  ): Promise<void> {
    try {
      await firstValueFrom(
        this.http.delete(
          `${instanceUrl}/api/v4/projects/${encodeURIComponent(projectId)}/hooks/${hookId}`,
          { headers: { 'Private-Token': token }, timeout: REQUEST_TIMEOUT_MS },
        ),
      );
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        return;
      }
      throw this.mapGitlabRequestError(error);
    }
  }

  mapGitlabRequestError(error: unknown): never {
    // axios.isAxiosError() (not `instanceof AxiosError`) — `instanceof` can
    // silently return false here due to a dual-package-hazard between how
    // @nestjs/axios's internal HttpService loads axios (as ESM, `file://`
    // resolution — visible in the stack trace) versus how this file imports
    // it, even though there's only one axios version in node_modules. The
    // mismatch meant every GitLab 401/403 was falling through to the
    // `throw error as Error` below and surfacing as an unhandled 500
    // instead of the intended 422 token_invalid.
    if (axios.isAxiosError(error)) {
      if (error.code === 'ECONNABORTED') {
        throw new HttpException(
          { field: 'instance_url', message: 'provider_unreachable' },
          HttpStatus.BAD_GATEWAY,
        );
      }
      if (error.response?.status === 401 || error.response?.status === 403) {
        throw new UnprocessableEntityException({
          field: 'token',
          message: 'token_invalid',
        });
      }
      // GitLab understood the request and refused it — retrying cannot
      // help, and "unreachable" would send whoever reads the error looking
      // at the network. (404 stays instance_unreachable below: a wrong
      // instance URL at connect time answers 404.)
      if (error.response?.status === 400) {
        const data = error.response.data as
          { message?: unknown; error?: unknown } | undefined;
        throw new UnprocessableEntityException({
          field: 'request',
          message: 'provider_bad_request',
          // GitLab's own reason ("Provide at least 2 refs") — what makes
          // the failure diagnosable. Short, never echoes the token.
          detail: JSON.stringify(data?.message ?? data?.error ?? '').slice(
            0,
            200,
          ),
        });
      }
      throw new UnprocessableEntityException({
        field: 'instance_url',
        message: 'instance_unreachable',
      });
    }
    throw error as Error;
  }

  normalizeInstanceUrl(url: string): string {
    return url.trim().replace(/\/+$/, '');
  }
}

// GitLab's answer to a review call, as a ProviderReviewError: what failed
// decides whether the review-sync queue retries.
function toReviewError(error: unknown): ProviderReviewError {
  if (!axios.isAxiosError(error)) {
    return new ProviderReviewError(
      'unknown',
      true,
      error instanceof Error ? error.message.slice(0, 200) : undefined,
    );
  }
  const status = error.response?.status;
  const data = error.response?.data as { message?: unknown } | undefined;
  const detail = JSON.stringify(data?.message ?? '').slice(0, 200);
  if (status === undefined || status === 429 || status >= 500) {
    return new ProviderReviewError('provider_unreachable', true, detail);
  }
  // The pinned sha is no longer the MR's head.
  if (status === 409) {
    return new ProviderReviewError('head_changed', false, detail);
  }
  // The token's user may not approve (author, not an eligible approver).
  if (status === 401) {
    return new ProviderReviewError('not_allowed', false, detail);
  }
  if (status === 403 || status === 404) {
    return new ProviderReviewError('insufficient_permission', false, detail);
  }
  return new ProviderReviewError('unknown', false, detail);
}

// GitLab's answer to a merge, as a ProviderMergeError.
function toMergeError(error: unknown): ProviderMergeError {
  if (!axios.isAxiosError(error)) {
    return new ProviderMergeError(
      'provider_unreachable',
      error instanceof Error ? error.message.slice(0, 300) : undefined,
    );
  }
  const status = error.response?.status;
  const data = error.response?.data as { message?: unknown } | undefined;
  const detail = JSON.stringify(data?.message ?? '').slice(0, 300);
  if (status === 409) {
    return new ProviderMergeError('head_changed', detail);
  }
  if (status === 405 || status === 406 || status === 422) {
    return new ProviderMergeError('not_mergeable', detail);
  }
  if (status === 401 || status === 403 || status === 404) {
    return new ProviderMergeError('insufficient_permission', detail);
  }
  return new ProviderMergeError('provider_unreachable', detail);
}

// GitLab's answer to a comment call, as a ProviderCommentError.
function toCommentError(error: unknown): ProviderCommentError {
  if (error instanceof ProviderCommentError) {
    return error;
  }
  if (!axios.isAxiosError(error)) {
    return new ProviderCommentError(
      'unknown',
      true,
      error instanceof Error ? error.message.slice(0, 200) : undefined,
    );
  }
  const status = error.response?.status;
  const data = error.response?.data as { message?: unknown } | undefined;
  const detail = JSON.stringify(data?.message ?? '').slice(0, 200);
  if (status === undefined || status === 429 || status >= 500) {
    return new ProviderCommentError('provider_unreachable', true, detail);
  }
  if (status === 401 || status === 403 || status === 404) {
    return new ProviderCommentError('insufficient_permission', false, detail);
  }
  // A position GitLab cannot map ("line_code can't be blank").
  if (status === 400 || status === 422) {
    return new ProviderCommentError('invalid_position', false, detail);
  }
  return new ProviderCommentError('unknown', false, detail);
}
