import { randomBytes } from 'crypto';
import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import { Logger } from 'winston';
import { PrismaService } from '../../common/prisma/prisma.service';
import { EncryptionService } from '../../common/encryption/encryption.service';
import { Prisma } from '../../generated/prisma/client';
import {
  IntegrationState,
  Provider,
  ReviewPolicy,
} from '../../generated/prisma/enums';
import {
  GithubAppService,
  type GithubBranch,
} from '../integrations/github-app.service';
import { GitlabApiService } from '../integrations/gitlab-api.service';
import { BranchListResponseDto } from './dto/branch-list-response.dto';
import { RepoScanConfigResponseDto } from './dto/repo-scan-config-response.dto';
import { UpdateScanConfigDto } from './dto/update-scan-config.dto';
import {
  CreateReposDto,
  type DefaultPolicyWireValue,
} from './dto/create-repos.dto';
import {
  CreateReposResponseDto,
  type CreateReposItemResult,
} from './dto/create-repos-response.dto';
import { RepositoryListItemDto } from './dto/repository-list-item.dto';
import { RepositoryDetailDto } from './dto/repository-detail.dto';

// Mirrors GithubInstallIntentDto's returnTo mapping pattern — lowercase
// wire value in, Prisma enum out, kept as a lookup table rather than an
// if/else chain.
const DEFAULT_POLICY_MAP: Record<DefaultPolicyWireValue, ReviewPolicy> = {
  manual_only: ReviewPolicy.MANUAL_ONLY,
  allow_ai: ReviewPolicy.ALLOW_AI,
  require_both: ReviewPolicy.REQUIRE_BOTH,
};

// Branch names allowed at MVP: exact names only (D6, PRD v1.4.2) — no
// glob/wildcard support, so anything that looks like one is rejected
// outright rather than silently treated as a literal string.
const INVALID_BRANCH_NAME_PATTERN = /[\s*?[\]]/;

interface ProviderBranches {
  path: string;
  defaultBranch: string;
  branches: string[];
  total: number;
  truncated: boolean;
}

@Injectable()
export class ReposService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryptionService: EncryptionService,
    private readonly githubAppService: GithubAppService,
    private readonly gitlabApiService: GitlabApiService,
    private readonly configService: ConfigService,
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
  ) {}

  async getBranchesForCandidate(
    organizationId: string,
    source: Provider,
    providerRepoId: string,
  ): Promise<BranchListResponseDto> {
    const integration = await this.findIntegrationOrThrow(
      organizationId,
      source,
    );
    const result = await this.fetchProviderBranches(
      integration,
      providerRepoId,
    );
    return new BranchListResponseDto({
      defaultBranch: result.defaultBranch,
      branches: result.branches,
      total: result.total,
      truncated: result.truncated,
      fetchedAt: new Date(),
    });
  }

  async getBranchesForRepo(
    organizationId: string,
    repositoryId: string,
  ): Promise<BranchListResponseDto> {
    const repository = await this.prisma.repository.findUnique({
      where: { id: repositoryId },
      include: { integration: true },
    });
    // organizationId is checked against the row, not passed into the
    // `where` clause, so a repo that exists but belongs to another org
    // surfaces identically to one that doesn't exist at all (D5 tenancy —
    // never leak whether a foreign-org id exists).
    if (!repository || repository.organizationId !== organizationId) {
      throw new NotFoundException('Repository not found.');
    }

    const result = await this.fetchProviderBranches(
      repository.integration,
      repository.externalId,
      repository.path,
    );
    return new BranchListResponseDto({
      defaultBranch: result.defaultBranch,
      branches: result.branches,
      total: result.total,
      truncated: result.truncated,
      fetchedAt: new Date(),
    });
  }

  async getScanConfig(
    organizationId: string,
    repositoryId: string,
  ): Promise<RepoScanConfigResponseDto> {
    const scanConfig = await this.findScanConfigOrThrow(
      organizationId,
      repositoryId,
    );
    return new RepoScanConfigResponseDto({
      defaultBranch: scanConfig.defaultBranch,
      branches: scanConfig.branches,
      defaultBranchChangedAt: scanConfig.defaultBranchChangedAt,
    });
  }

  async updateScanConfig(
    organizationId: string,
    repositoryId: string,
    dto: UpdateScanConfigDto,
  ): Promise<RepoScanConfigResponseDto> {
    const scanConfig = await this.findScanConfigOrThrow(
      organizationId,
      repositoryId,
    );

    const trimmed = dto.branches.map((branch) => branch.trim());
    if (trimmed.length === 0) {
      throw new UnprocessableEntityException({
        field: 'branches',
        message: 'empty_scope',
      });
    }
    for (const branch of trimmed) {
      if (branch.length === 0 || INVALID_BRANCH_NAME_PATTERN.test(branch)) {
        throw new UnprocessableEntityException({
          field: 'branches',
          message: 'invalid_branch_name',
          branch,
        });
      }
    }

    // Server always inserts defaultBranch if the client omitted it
    // (idempotent — PRD v1.4.2 §12.4), and it always sorts first.
    const withoutDefault = trimmed.filter(
      (branch) => branch !== scanConfig.defaultBranch,
    );
    const branches = [scanConfig.defaultBranch, ...withoutDefault];

    const updated = await this.prisma.repoScanConfig.update({
      where: { id: scanConfig.id },
      data: { branches },
    });

    // TODO Fase 4: record an AuditLog entry (repo.scan_config_updated) here
    // with {before: scanConfig.branches, after: branches} — AuditLog model
    // doesn't exist yet.

    return new RepoScanConfigResponseDto({
      defaultBranch: updated.defaultBranch,
      branches: updated.branches,
      defaultBranchChangedAt: updated.defaultBranchChangedAt,
    });
  }

  // Sequential per item, not Promise.all — deliberately avoids bursting
  // concurrent requests at the provider's rate limit when a wizard submits
  // many repos in one call. Partial success: one repo's failure never
  // rolls back or blocks the others, since each is inserted through its
  // own transaction.
  //
  // TODO Fase 4: once `projects.length > 10`, enqueue a BullMQ job and
  // return 202 {jobId} instead of processing synchronously — synchronous
  // processing here risks a request timeout for large batches. Acceptable
  // trade-off for this Fase 3 MVP only.
  async createRepos(
    organizationId: string,
    dto: CreateReposDto,
  ): Promise<CreateReposResponseDto> {
    const items: CreateReposItemResult[] = [];
    // One request is always for a single provider (the FE only ever shows
    // one candidates list — GitHub or GitLab — per submission, per D4), so
    // this integration lookup happens once up front rather than per item.
    const source = dto.source === 'github' ? Provider.GITHUB : Provider.GITLAB;
    const integration = await this.findIntegrationOrThrow(
      organizationId,
      source,
    );
    const defaultPolicy = DEFAULT_POLICY_MAP[dto.defaultPolicy];

    for (const project of dto.projects) {
      const providerRepoId = String(project.id);
      let providerBranches: ProviderBranches;
      try {
        providerBranches = await this.fetchProviderBranches(
          integration,
          providerRepoId,
        );
      } catch {
        items.push({
          status: 'failed',
          providerRepoId: project.id,
          error: 'provider_unreachable',
        });
        continue;
      }

      const requested = project.monitoredBranches ?? [
        providerBranches.defaultBranch,
      ];
      const unknown = requested.find(
        (branch) => !providerBranches.branches.includes(branch),
      );
      if (unknown) {
        items.push({
          status: 'failed',
          providerRepoId: project.id,
          error: 'unknown_branch',
          branch: unknown,
        });
        continue;
      }

      const monitoredBranches = requested.includes(
        providerBranches.defaultBranch,
      )
        ? requested
        : [providerBranches.defaultBranch, ...requested];

      const path = providerBranches.path;

      try {
        const created = await this.prisma.$transaction(async (tx) => {
          const repository = await tx.repository.create({
            data: {
              organizationId,
              integrationId: integration.id,
              provider: integration.source,
              externalId: providerRepoId,
              path,
              defaultBranch: providerBranches.defaultBranch,
            },
          });
          await tx.organization.update({
            where: { id: organizationId },
            data: { onboardingCompleted: true },
          });
          await tx.repoScanConfig.create({
            data: {
              organizationId,
              repositoryId: repository.id,
              defaultBranch: providerBranches.defaultBranch,
              branches: monitoredBranches,
            },
          });
          await tx.branchScanPolicy.createMany({
            data: monitoredBranches.map((branch) => ({
              organizationId,
              repositoryId: repository.id,
              branch,
              policy: defaultPolicy,
            })),
          });
          return repository;
        });

        const webhook = await this.installWebhook(created.id, integration);

        // TODO Fase 4: record an AuditLog entry (repo.connected) here.
        items.push({
          status: 'ok',
          repoId: created.id,
          path,
          defaultBranch: providerBranches.defaultBranch,
          monitoredBranches,
          webhook,
        });
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        ) {
          items.push({
            status: 'failed',
            providerRepoId: project.id,
            error: 'already_connected',
          });
          continue;
        }
        throw error;
      }
    }

    return new CreateReposResponseDto({ items });
  }

  // Read back by ReposController after createRepos, to decide whether the
  // caller's session token still reflects the organization's onboarding
  // state. Separate from createRepos' return value on purpose: the flag is
  // set inside the per-repo transaction, so only the row itself is
  // authoritative about whether any repo actually landed.
  async isOnboardingCompleted(organizationId: string): Promise<boolean> {
    const organization = await this.prisma.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { onboardingCompleted: true },
    });
    return organization.onboardingCompleted ?? false;
  }

  async list(organizationId: string): Promise<RepositoryListItemDto[]> {
    const repositories = await this.prisma.repository.findMany({
      where: { organizationId },
      include: { scanConfig: true },
    });

    return repositories.map(
      (repository) =>
        new RepositoryListItemDto({
          id: repository.id,
          provider: repository.provider,
          path: repository.path,
          defaultBranch: repository.defaultBranch,
          monitoredBranchCount: repository.scanConfig?.branches.length ?? 0,
        }),
    );
  }

  async getDetail(
    organizationId: string,
    repositoryId: string,
  ): Promise<RepositoryDetailDto> {
    const repository = await this.prisma.repository.findUnique({
      where: { id: repositoryId },
      include: { scanConfig: true },
    });
    if (!repository || repository.organizationId !== organizationId) {
      throw new NotFoundException('Repository not found.');
    }

    return new RepositoryDetailDto({
      id: repository.id,
      provider: repository.provider,
      path: repository.path,
      defaultBranch: repository.defaultBranch,
      scanConfig: repository.scanConfig
        ? new RepoScanConfigResponseDto({
            defaultBranch: repository.scanConfig.defaultBranch,
            branches: repository.scanConfig.branches,
            defaultBranchChangedAt:
              repository.scanConfig.defaultBranchChangedAt,
          })
        : null,
    });
  }

  private async findScanConfigOrThrow(
    organizationId: string,
    repositoryId: string,
  ) {
    const repository = await this.prisma.repository.findUnique({
      where: { id: repositoryId },
      include: { scanConfig: true },
    });
    if (!repository || repository.organizationId !== organizationId) {
      throw new NotFoundException('Repository not found.');
    }
    if (!repository.scanConfig) {
      // Every Repository is created together with its RepoScanConfig in
      // createRepos()'s transaction — this is a data-invariant assertion,
      // not a user-facing validation, same pattern as
      // IntegrationsService.assertGitlabCredential.
      throw new Error(
        'Repository is missing its RepoScanConfig — data invariant violated.',
      );
    }
    return repository.scanConfig;
  }

  private async findIntegrationOrThrow(
    organizationId: string,
    source: Provider,
  ) {
    const integration = await this.prisma.integration.findUnique({
      where: { organizationId_source: { organizationId, source } },
    });
    if (!integration) {
      throw new ConflictException({
        field: 'organizationId',
        message:
          source === Provider.GITLAB
            ? 'gitlab_not_connected'
            : 'github_not_installed',
      });
    }
    if (integration.state === IntegrationState.TOKEN_EXPIRED) {
      throw new ConflictException({
        field: 'organizationId',
        message: 'token_expired',
      });
    }
    return integration;
  }

  // GitHub App webhooks are App-wide (configured once in the App's own
  // dashboard) — there is no per-repo API call to make, so a GitHub repo's
  // events already flow the moment the App was granted access to it.
  // GitLab has no such App-wide concept: a hook has to be registered on
  // this specific project, which is what this method actually does.
  // Failure here does not roll back the repository — see the plan's
  // partial-success rationale: a repo that exists but hasn't got a working
  // webhook yet is still more useful than no repo at all, and there's no
  // retry endpoint yet (TODO Fase 4) so the failure is only surfaced to the
  // caller for now, not auto-recovered.
  private async installWebhook(
    repositoryId: string,
    integration: {
      source: Provider;
      instanceUrl: string | null;
      encryptedToken: string | null;
    },
  ): Promise<
    | { status: 'installed' }
    | { status: 'app_managed' }
    | { status: 'failed'; error: string }
  > {
    if (integration.source === Provider.GITHUB) {
      return { status: 'app_managed' };
    }

    if (!integration.instanceUrl || !integration.encryptedToken) {
      throw new Error(
        'Integration row with source GITLAB is missing its GitLab credential fields — data invariant violated.',
      );
    }

    try {
      const repository = await this.prisma.repository.findUniqueOrThrow({
        where: { id: repositoryId },
      });
      const token = this.encryptionService.decrypt(integration.encryptedToken);
      const secret = randomBytes(32).toString('base64url');
      const backendUrl = this.configService.getOrThrow<string>('backendUrl');

      const hook = await this.gitlabApiService.createProjectHook(
        integration.instanceUrl,
        token,
        repository.externalId,
        {
          url: `${backendUrl}/api/v1/webhooks/gitlab`,
          secretToken: secret,
        },
      );

      await this.prisma.repository.update({
        where: { id: repositoryId },
        data: {
          gitlabWebhookId: hook.id,
          encryptedWebhookSecret: this.encryptionService.encrypt(secret),
        },
      });

      return { status: 'installed' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn('Failed to install GitLab webhook for repository', {
        repositoryId,
        error: message,
      });
      return { status: 'failed', error: 'webhook_install_failed' };
    }
  }

  private async fetchProviderBranches(
    integration: {
      source: Provider;
      installationId: string | null;
      instanceUrl: string | null;
      encryptedToken: string | null;
    },
    providerRepoId: string,
    knownPath?: string,
  ): Promise<ProviderBranches> {
    if (integration.source === Provider.GITHUB) {
      if (!integration.installationId) {
        throw new Error(
          'Integration row with source GITHUB is missing installationId — data invariant violated.',
        );
      }
      const [owner, repo] = await this.splitGithubPath(
        knownPath,
        integration.installationId,
        providerRepoId,
      );
      const [detail, branchResult] = await Promise.all([
        this.githubAppService.fetchRepository(
          integration.installationId,
          owner,
          repo,
        ),
        this.githubAppService.listBranches(
          integration.installationId,
          owner,
          repo,
        ),
      ]);
      return this.toProviderBranches(
        `${owner}/${repo}`,
        detail.default_branch,
        branchResult,
      );
    }

    if (!integration.instanceUrl || !integration.encryptedToken) {
      throw new Error(
        'Integration row with source GITLAB is missing its GitLab credential fields — data invariant violated.',
      );
    }
    const token = this.encryptionService.decrypt(integration.encryptedToken);
    const [detail, branchResult] = await Promise.all([
      this.gitlabApiService.fetchProject(
        integration.instanceUrl,
        token,
        providerRepoId,
      ),
      this.gitlabApiService.fetchBranches(
        integration.instanceUrl,
        token,
        providerRepoId,
      ),
    ]);
    return this.toProviderBranches(
      detail.path_with_namespace,
      detail.default_branch,
      branchResult,
    );
  }

  private toProviderBranches(
    path: string,
    defaultBranch: string,
    branchResult: { branches: GithubBranch[]; truncated: boolean },
  ): ProviderBranches {
    const names = branchResult.branches.map((branch) => branch.name);
    const rest = names
      .filter((name) => name !== defaultBranch)
      .sort((a, b) => a.localeCompare(b));
    return {
      path,
      defaultBranch,
      branches: [defaultBranch, ...rest],
      total: names.length,
      truncated: branchResult.truncated,
    };
  }

  // GitHub branch/repo endpoints need `owner`/`repo` split out of a
  // "owner/repo" full_name — Repository.path already stores that shape
  // (see GithubCandidateDto), but a not-yet-connected candidate (wizard
  // step 2) only has the numeric id, so this falls back to resolving it
  // through the installation repositories list when no stored path exists.
  private async splitGithubPath(
    knownPath: string | undefined,
    installationId: string,
    providerRepoId: string,
  ): Promise<[string, string]> {
    if (knownPath) {
      const [owner, repo] = knownPath.split('/');
      return [owner, repo];
    }
    const repositories =
      await this.githubAppService.listInstallationRepositories(installationId);
    const match = repositories.find(
      (repository) => String(repository.id) === providerRepoId,
    );
    if (!match) {
      throw new NotFoundException('Repository not found.');
    }
    const [owner, repo] = match.full_name.split('/');
    return [owner, repo];
  }
}
