/* eslint-disable @typescript-eslint/only-throw-error */
import { Injectable, UnprocessableEntityException } from '@nestjs/common';
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
