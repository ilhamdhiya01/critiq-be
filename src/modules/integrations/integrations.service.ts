/* eslint-disable @typescript-eslint/only-throw-error */
import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import axios from 'axios';
import { PrismaService } from '../../common/prisma/prisma.service';
import { EncryptionService } from '../../common/encryption/encryption.service';
import { Prisma } from '../../generated/prisma/client';
import {
  CredentialKind,
  IntegrationState,
  Provider,
  TokenKind,
} from '../../generated/prisma/enums';
import { ConnectGitlabDto } from './dto/connect-gitlab.dto';
import { IntegrationResponseDto } from './dto/integration-response.dto';
import { GitlabCandidateDto } from './dto/gitlab-candidate.dto';
import { GithubCandidateDto } from './dto/github-candidate.dto';
import {
  GithubAppService,
  type GithubInstallation,
} from './github-app.service';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import { Logger } from 'winston';

interface GitlabUser {
  id: number;
  username: string;
}

interface GitlabPersonalAccessTokenSelf {
  scopes: string[];
  expires_at: string | null;
}

interface GitlabProject {
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

const MAINTAINER_ACCESS_LEVEL = 40;
const EXPIRING_SOON_THRESHOLD_DAYS = 14;
// GitLab bot usernames for group access tokens follow this pattern (e.g.
// `platform_bot`, `group_1_bot_a1`) — this is the only signal available to
// tell a group token from a personal one, per PRD §4 D3.
const GROUP_TOKEN_USERNAME_PATTERN = /_bot/i;

@Injectable()
export class IntegrationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryptionService: EncryptionService,
    private readonly http: HttpService,
    private readonly configService: ConfigService,
    private readonly githubAppService: GithubAppService,
    @Inject(WINSTON_MODULE_PROVIDER) private logger: Logger,
  ) {}

  async list(organizationId: string): Promise<IntegrationResponseDto[]> {
    const integrations = await this.prisma.integration.findMany({
      where: { organizationId },
    });

    return integrations.map((integration) => this.toResponseDto(integration));
  }

  async connectGitlab(
    organizationId: string,
    connectedByUserId: string,
    dto: ConnectGitlabDto,
  ): Promise<IntegrationResponseDto> {
    const instanceUrl = this.normalizeInstanceUrl(dto.instance_url);

    const user = await this.fetchGitlabUser(instanceUrl, dto.token);
    const tokenInfo = await this.fetchGitlabTokenSelf(instanceUrl, dto.token);
    const projects = await this.fetchMaintainerProjects(instanceUrl, dto.token);

    if (projects.length === 0) {
      throw new UnprocessableEntityException({
        field: 'token',
        message: 'no_maintainer_project',
      });
    }

    if (!tokenInfo.scopes.includes('api')) {
      throw new UnprocessableEntityException({
        field: 'token',
        message: 'scope_missing',
      });
    }

    if (!tokenInfo.expires_at) {
      // GitLab enforces a max token lifetime (400 days) in every current
      // version, so a missing expiry means an old self-hosted instance that
      // predates that requirement — PRD §13 leaves the exact handling of
      // this as an open question. Rejecting outright (rather than guessing
      // a default) is the safer default until that's answered, since
      // `Integration.expiresAt` is a required column.
      throw new UnprocessableEntityException({
        field: 'token',
        message: 'token_missing_expiry',
      });
    }

    const tokenKind = GROUP_TOKEN_USERNAME_PATTERN.test(user.username)
      ? TokenKind.GROUP
      : TokenKind.PERSONAL;
    const expiresAt = new Date(tokenInfo.expires_at);
    const state = this.resolveStateFromExpiry(expiresAt);
    const encryptedToken = this.encryptionService.encrypt(dto.token);
    const groupsCache = projects.map((project) => ({
      id: project.id,
      path: project.path_with_namespace,
    }));

    const integration = await this.prisma.integration.upsert({
      where: {
        organizationId_source: {
          organizationId,
          source: Provider.GITLAB,
        },
      },
      create: {
        organizationId,
        source: Provider.GITLAB,
        instanceUrl,
        credentialKind: CredentialKind.GROUP_TOKEN,
        encryptedToken,
        expiresAt,
        tokenKind,
        tokenUsername: user.username,
        groupsCache,
        state,
        connectedByUserId,
      },
      // Idempotent: calling this again replaces the stored token entirely
      // (PRD §12.3) — this is how "Replace token" (F17/D5) works, there is
      // no separate replace endpoint.
      update: {
        instanceUrl,
        encryptedToken,
        expiresAt,
        tokenKind,
        tokenUsername: user.username,
        groupsCache,
        state,
        connectedByUserId,
      },
    });

    return this.toResponseDto(integration);
  }

  // Persists a GitHub App installation already verified server-side by the
  // caller (GithubAppService.verifyInstallation) — this method never talks
  // to GitHub itself, it only writes the Integration row. Idempotent on
  // [organizationId, source] the same way connectGitlab is: calling this
  // again for the same org (e.g. `setup_action=update`) replaces the row.
  //
  // `setupAction === 'request'` means a non-owner org member requested the
  // install and it's pending a separate GitHub-side owner approval — the
  // row is still written (so the org has a visible, queryable "GitHub
  // connection in progress" state) but as PENDING_APPROVAL, not ACTIVE.
  // Nothing here transitions it to ACTIVE automatically later: that would
  // require GitHub App webhook ingestion (Fase 4, not built yet) to detect
  // the owner's approval — an admin has to re-run the install flow after
  // approval to complete this.
  async connectGithub(
    organizationId: string,
    connectedByUserId: string,
    installation: GithubInstallation,
    setupAction: 'install' | 'update' | 'request',
  ): Promise<IntegrationResponseDto> {
    const installationId = String(installation.id);
    const installationLogin = installation.account?.login ?? null;
    const appSlug = this.configService.get<string>('githubApp.slug') ?? null;
    const state =
      setupAction === 'request'
        ? IntegrationState.PENDING_APPROVAL
        : IntegrationState.ACTIVE;

    try {
      const integration = await this.prisma.integration.upsert({
        where: {
          organizationId_source: {
            organizationId,
            source: Provider.GITHUB,
          },
        },
        create: {
          organizationId,
          source: Provider.GITHUB,
          credentialKind: CredentialKind.INSTALLATION,
          installationId,
          installationLogin,
          appSlug,
          state,
          connectedByUserId,
        },
        update: {
          credentialKind: CredentialKind.INSTALLATION,
          installationId,
          installationLogin,
          appSlug,
          state,
          connectedByUserId,
        },
      });
      return this.toResponseDto(integration);
    } catch (error) {
      // `installationId` is globally unique (one GitHub installation can
      // only ever back one Integration row) — this fires when the same
      // GitHub installation is already attached to a DIFFERENT
      // organization (e.g. an admin re-triggers install on the same
      // GitHub org from a second Critiq org). Surfaced as a clear,
      // typed conflict rather than a raw DB constraint error leaking
      // through, matching the gitlab_not_connected/token_expired pattern
      // already used elsewhere in this file.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException({
          field: 'installation_id',
          message: 'installation_in_use',
        });
      }
      throw error;
    }
  }

  async disconnectGitlab(organizationId: string): Promise<void> {
    const integration = await this.prisma.integration.findUnique({
      where: {
        organizationId_source: { organizationId, source: Provider.GITLAB },
      },
    });
    if (!integration) {
      throw new NotFoundException(
        'No GitLab integration found for this organization.',
      );
    }

    // TODO Fase 4: revoke webhooks on all connected GitLab repos before
    // deleting the Integration row — there is nothing to revoke yet since
    // the `repos` module (Fase 3) doesn't exist, so a connected GitLab repo
    // with a live webhook cannot exist yet either.
    await this.prisma.integration.delete({ where: { id: integration.id } });
  }

  async getHealth(organizationId: string): Promise<IntegrationResponseDto> {
    const integration = await this.prisma.integration.findUnique({
      where: {
        organizationId_source: { organizationId, source: Provider.GITLAB },
      },
    });
    if (!integration) {
      throw new NotFoundException(
        'No GitLab integration found for this organization.',
      );
    }

    const credential = this.assertGitlabCredential(integration);
    const token = this.encryptionService.decrypt(credential.encryptedToken);
    let state: IntegrationState;
    try {
      await this.fetchGitlabUser(credential.instanceUrl, token);
      state = this.resolveStateFromExpiry(credential.expiresAt);
    } catch {
      state = IntegrationState.INVALID;
    }

    const updated = await this.prisma.integration.update({
      where: { id: integration.id },
      data: { state },
    });

    return this.toResponseDto(updated);
  }

  async listGitlabCandidates(
    organizationId: string,
    query?: string,
  ): Promise<GitlabCandidateDto[]> {
    const integration = await this.prisma.integration.findUnique({
      where: {
        organizationId_source: { organizationId, source: Provider.GITLAB },
      },
    });
    if (!integration) {
      throw new ConflictException({
        field: 'organizationId',
        message: 'gitlab_not_connected',
      });
    }
    if (integration.state === IntegrationState.TOKEN_EXPIRED) {
      throw new ConflictException({
        field: 'organizationId',
        message: 'token_expired',
        expires_at: integration.expiresAt,
      });
    }

    const credential = this.assertGitlabCredential(integration);
    const token = this.encryptionService.decrypt(credential.encryptedToken);
    // TODO Fase 3: filter out projects already linked via Repository — the
    // `repos` module doesn't exist yet, so "candidates" currently returns
    // every Maintainer+ project unfiltered. On a fresh org this is already
    // correct (nothing is connected yet), so the endpoint isn't half-built,
    // just not yet excluding already-connected repos.
    const projects = await this.fetchMaintainerProjects(
      credential.instanceUrl,
      token,
      query,
    );

    return projects.map(
      (project) =>
        new GitlabCandidateDto({
          id: project.id,
          path: project.path_with_namespace,
          lang: project.language ?? null,
          visibility: project.visibility,
          accessLevel: this.resolveAccessLevel(project),
        }),
    );
  }

  async listGithubCandidates(
    organizationId: string,
    query?: string,
  ): Promise<GithubCandidateDto[]> {
    const integration = await this.prisma.integration.findUnique({
      where: {
        organizationId_source: { organizationId, source: Provider.GITHUB },
      },
    });
    if (!integration) {
      throw new ConflictException({
        field: 'organizationId',
        message: 'github_not_connected',
      });
    }

    const installationId = this.assertGithubInstallationId(integration);
    const repos = await this.githubAppService.listInstallationRepositories(
      installationId,
      query,
    );

    return repos.map(
      (repo) =>
        new GithubCandidateDto({
          id: repo.id,
          path: repo.full_name,
          lang: repo.language,
          private: repo.private,
        }),
    );
  }

  private normalizeInstanceUrl(url: string): string {
    return url.trim().replace(/\/+$/, '');
  }

  // Mirrors assertGitlabCredential's pattern: a data-invariant assertion,
  // not a user-facing validation. Every GITHUB row is always written with
  // installationId set (in connectGithub's upsert), so this should never
  // actually throw.
  private assertGithubInstallationId(integration: {
    installationId: string | null;
  }): string {
    if (integration.installationId === null) {
      throw new Error(
        'Integration row with source GITHUB is missing installationId — data invariant violated.',
      );
    }
    return integration.installationId;
  }

  // Narrows an Integration row known (by construction — the row was looked
  // up with `source: GITLAB`) to have its GitLab-only columns populated.
  // These columns are nullable at the schema level only because a GITHUB
  // row leaves them null — every GITLAB row is always written with all of
  // them set together in connectGitlab()'s upsert, so this should never
  // actually throw. It exists so a schema/data invariant this code relies
  // on is asserted explicitly instead of silently trusted with `!`.
  private assertGitlabCredential(integration: {
    instanceUrl: string | null;
    encryptedToken: string | null;
    expiresAt: Date | null;
  }): { instanceUrl: string; encryptedToken: string; expiresAt: Date } {
    if (
      integration.instanceUrl === null ||
      integration.encryptedToken === null ||
      integration.expiresAt === null
    ) {
      throw new Error(
        'Integration row with source GITLAB is missing its GitLab credential fields — data invariant violated.',
      );
    }
    return {
      instanceUrl: integration.instanceUrl,
      encryptedToken: integration.encryptedToken,
      expiresAt: integration.expiresAt,
    };
  }

  private async fetchGitlabUser(
    instanceUrl: string,
    token: string,
  ): Promise<GitlabUser> {
    try {
      const response = await firstValueFrom(
        this.http.get<GitlabUser>(`${instanceUrl}/api/v4/user`, {
          headers: { 'Private-Token': token },
        }),
      );
      return response.data;
    } catch (error) {
      throw this.mapGitlabRequestError(error);
    }
  }

  private async fetchGitlabTokenSelf(
    instanceUrl: string,
    token: string,
  ): Promise<GitlabPersonalAccessTokenSelf> {
    try {
      const response = await firstValueFrom(
        this.http.get<GitlabPersonalAccessTokenSelf>(
          `${instanceUrl}/api/v4/personal_access_tokens/self`,
          { headers: { 'Private-Token': token } },
        ),
      );
      return response.data;
    } catch (error) {
      throw this.mapGitlabRequestError(error);
    }
  }

  private async fetchMaintainerProjects(
    instanceUrl: string,
    token: string,
    search?: string,
  ): Promise<GitlabProject[]> {
    try {
      const response = await firstValueFrom(
        this.http.get<GitlabProject[]>(`${instanceUrl}/api/v4/projects`, {
          headers: { 'Private-Token': token },
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

  private mapGitlabRequestError(error: unknown): never {
    // axios.isAxiosError() (not `instanceof AxiosError`) — `instanceof` can
    // silently return false here due to a dual-package-hazard between how
    // @nestjs/axios's internal HttpService loads axios (as ESM, `file://`
    // resolution — visible in the stack trace) versus how this file imports
    // it, even though there's only one axios version in node_modules. The
    // mismatch meant every GitLab 401/403 was falling through to the
    // `throw error as Error` below and surfacing as an unhandled 500
    // instead of the intended 422 token_invalid.
    if (axios.isAxiosError(error)) {
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

  private resolveStateFromExpiry(expiresAt: Date): IntegrationState {
    const daysUntilExpiry =
      (expiresAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
    if (daysUntilExpiry <= 0) {
      return IntegrationState.TOKEN_EXPIRED;
    }
    if (daysUntilExpiry <= EXPIRING_SOON_THRESHOLD_DAYS) {
      return IntegrationState.EXPIRING_SOON;
    }
    return IntegrationState.ACTIVE;
  }

  private resolveAccessLevel(project: GitlabProject): number {
    return Math.max(
      project.permissions?.project_access?.access_level ?? 0,
      project.permissions?.group_access?.access_level ?? 0,
    );
  }

  private toResponseDto(integration: {
    source: Provider;
    credentialKind: CredentialKind;
    state: IntegrationState;
    instanceUrl: string | null;
    tokenKind: TokenKind | null;
    tokenUsername: string | null;
    encryptedToken: string | null;
    expiresAt: Date | null;
    groupsCache: unknown;
    installationId: string | null;
    installationLogin: string | null;
    appSlug: string | null;
  }): IntegrationResponseDto {
    return new IntegrationResponseDto({
      source: integration.source,
      credentialKind: integration.credentialKind,
      state: integration.state,
      instanceUrl: integration.instanceUrl,
      tokenKind: integration.tokenKind,
      tokenUsername: integration.tokenUsername,
      tokenLast4: integration.encryptedToken
        ? this.encryptionService.decrypt(integration.encryptedToken).slice(-4)
        : null,
      expiresAt: integration.expiresAt,
      groups: integration.groupsCache,
      installationId: integration.installationId,
      installationLogin: integration.installationLogin,
      appSlug: integration.appSlug,
    });
  }
}
