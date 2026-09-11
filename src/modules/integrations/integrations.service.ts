/* eslint-disable @typescript-eslint/only-throw-error */
import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import axios from 'axios';
import { PrismaService } from '../../common/prisma/prisma.service';
import { EncryptionService } from '../../common/encryption/encryption.service';
import {
  CredentialKind,
  IntegrationState,
  Provider,
  TokenKind,
} from '../../generated/prisma/enums';
import { ConnectGitlabDto } from './dto/connect-gitlab.dto';
import { IntegrationResponseDto } from './dto/integration-response.dto';
import { GitlabCandidateDto } from './dto/gitlab-candidate.dto';
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

    const token = this.encryptionService.decrypt(integration.encryptedToken);
    let state: IntegrationState;
    try {
      await this.fetchGitlabUser(integration.instanceUrl, token);
      state = this.resolveStateFromExpiry(integration.expiresAt);
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

    const token = this.encryptionService.decrypt(integration.encryptedToken);
    // TODO Fase 3: filter out projects already linked via Repository — the
    // `repos` module doesn't exist yet, so "candidates" currently returns
    // every Maintainer+ project unfiltered. On a fresh org this is already
    // correct (nothing is connected yet), so the endpoint isn't half-built,
    // just not yet excluding already-connected repos.
    const projects = await this.fetchMaintainerProjects(
      integration.instanceUrl,
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

  private normalizeInstanceUrl(url: string): string {
    return url.trim().replace(/\/+$/, '');
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
    instanceUrl: string;
    credentialKind: CredentialKind;
    tokenKind: TokenKind;
    tokenUsername: string;
    encryptedToken: string;
    expiresAt: Date;
    state: IntegrationState;
    groupsCache: unknown;
  }): IntegrationResponseDto {
    return new IntegrationResponseDto({
      source: integration.source,
      instanceUrl: integration.instanceUrl,
      credentialKind: integration.credentialKind,
      tokenKind: integration.tokenKind,
      tokenUsername: integration.tokenUsername,
      tokenLast4: this.encryptionService
        .decrypt(integration.encryptedToken)
        .slice(-4),
      expiresAt: integration.expiresAt,
      state: integration.state,
      groups: integration.groupsCache,
    });
  }
}
