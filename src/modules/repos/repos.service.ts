import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { EncryptionService } from '../../common/encryption/encryption.service';
import { Prisma } from '../../generated/prisma/client';
import { IntegrationState, Provider } from '../../generated/prisma/enums';
import {
  GithubAppService,
  type GithubBranch,
} from '../integrations/github-app.service';
import { GitlabApiService } from '../integrations/gitlab-api.service';
import { BranchListResponseDto } from './dto/branch-list-response.dto';
import { RepoScanConfigResponseDto } from './dto/repo-scan-config-response.dto';
import { UpdateScanConfigDto } from './dto/update-scan-config.dto';
import { CreateReposDto } from './dto/create-repos.dto';
import {
  CreateReposResponseDto,
  type CreateReposItemResult,
} from './dto/create-repos-response.dto';
import { RepositoryListItemDto } from './dto/repository-list-item.dto';
import { RepositoryDetailDto } from './dto/repository-detail.dto';

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

    for (const project of dto.projects) {
      const providerRepoId = String(project.id);
      // Every item needs its own provider (GitHub vs GitLab) resolved —
      // the DTO doesn't carry `source` per item, so this infers it from
      // whichever org integration currently owns a candidate with this id.
      // In practice a single wizard submission is always for one provider
      // (D4: the wizard's repo source follows the login provider), so this
      // resolves to whichever of the two integrations exists for the org.
      let integration: Awaited<
        ReturnType<typeof this.resolveIntegrationForCandidate>
      >;
      try {
        integration = await this.resolveIntegrationForCandidate(
          organizationId,
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
              policy: dto.defaultPolicy,
            })),
          });
          return repository;
        });

        // TODO Fase 4: install a webhook for this repo here — webhook
        // infra doesn't exist yet, so `webhook.status` stays
        // 'not_configured' rather than claiming 'installed'.
        // TODO Fase 4: record an AuditLog entry (repo.connected) here.
        items.push({
          status: 'ok',
          repoId: created.id,
          path,
          defaultBranch: providerBranches.defaultBranch,
          monitoredBranches,
          webhook: { status: 'not_configured' },
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

  private async resolveIntegrationForCandidate(
    organizationId: string,
    providerRepoId: string,
  ) {
    void providerRepoId;
    // D4: the wizard's repo source always follows the org's login provider
    // — an org has at most one GitHub and one GitLab integration, and a
    // single wizard submission is only ever for one of them. There is no
    // per-item `source` in the request body to disambiguate further, so
    // this resolves to whichever integration exists (Admin-only route, and
    // connectRepos is only reachable after a candidates list from exactly
    // one provider was shown).
    const integrations = await this.prisma.integration.findMany({
      where: { organizationId },
    });
    const usable = integrations.find(
      (integration) => integration.state !== IntegrationState.TOKEN_EXPIRED,
    );
    if (!usable) {
      throw new ConflictException({
        field: 'organizationId',
        message: 'no_usable_integration',
      });
    }
    return usable;
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
