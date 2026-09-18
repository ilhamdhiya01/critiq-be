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

export interface GitlabProjectHook {
  id: number;
}

const MAINTAINER_ACCESS_LEVEL = 40;
const REQUEST_TIMEOUT_MS = 8000;
const BRANCH_PAGE_SIZE = 100;
const BRANCH_HARD_CAP = 500;

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

  // Paginates per_page=100 until a short page is returned, same shape as
  // GithubAppService.listInstallationRepositories — hard-capped at 500
  // total branches (PRD v1.4.2 §12.4) rather than fetching indefinitely.
  async fetchBranches(
    instanceUrl: string,
    token: string,
    projectId: string,
  ): Promise<{ branches: GitlabBranch[]; truncated: boolean }> {
    const branches: GitlabBranch[] = [];
    let page = 1;
    let truncated = false;

    while (true) {
      let response: { data: GitlabBranch[] };
      try {
        response = await firstValueFrom(
          this.http.get<GitlabBranch[]>(
            `${instanceUrl}/api/v4/projects/${encodeURIComponent(projectId)}/repository/branches`,
            {
              headers: { 'Private-Token': token },
              timeout: REQUEST_TIMEOUT_MS,
              params: { per_page: BRANCH_PAGE_SIZE, page },
            },
          ),
        );
      } catch (error) {
        throw this.mapGitlabRequestError(error);
      }

      branches.push(...response.data);

      if (branches.length >= BRANCH_HARD_CAP) {
        truncated = true;
        break;
      }
      if (response.data.length < BRANCH_PAGE_SIZE) {
        break;
      }
      page += 1;
    }

    return { branches: branches.slice(0, BRANCH_HARD_CAP), truncated };
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
