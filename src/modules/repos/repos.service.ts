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
  PullRequestState,
  ReviewPolicy,
  ScanStatus,
  ScanTrigger,
} from '../../generated/prisma/enums';
import { ScanQueueService } from '../../queue/scan-queue.service';
import { RULESET_VERSION } from '../../queue/rules/rules.constants';
import { assertGithubAccess } from '../integrations/github-access';
import { GithubAppService } from '../integrations/github-app.service';
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
import { RescanResponseDto } from './dto/rescan-response.dto';

// Mirrors GithubInstallIntentDto's returnTo mapping pattern — lowercase
// wire value in, Prisma enum out, kept as a lookup table rather than an
// if/else chain.
const DEFAULT_POLICY_MAP: Record<DefaultPolicyWireValue, ReviewPolicy> = {
  manual_only: ReviewPolicy.MANUAL_ONLY,
  allow_ai: ReviewPolicy.ALLOW_AI,
  require_both: ReviewPolicy.REQUIRE_BOTH,
};

function toPolicyWireValue(policy: ReviewPolicy): DefaultPolicyWireValue {
  return policy.toLowerCase() as DefaultPolicyWireValue;
}

// Branch names allowed at MVP: exact names only (D6, PRD v1.4.2) — no
// glob/wildcard support, so anything that looks like one is rejected
// outright rather than silently treated as a literal string.
const INVALID_BRANCH_NAME_PATTERN = /[\s*?[\]]/;

// Branches per list response (picker, wizard step 2). Small on purpose:
// the unfiltered list is a starting point — the most recently updated on
// GitLab — and anything else is reached with `?search=`.
const BRANCH_LIST_LIMIT = 50;

interface ProviderIntegration {
  source: Provider;
  installationId: string | null;
  instanceUrl: string | null;
  encryptedToken: string | null;
}

// What the repositories list and detail show beside the repo itself.
export interface RepositoryStats {
  openPullCount: number;
  // Active criticals in the latest scan of each open PR (criticalCount
  // already excludes suppressed findings).
  openCriticalCount: number;
  // The most recent DONE/FAILED scan of the repository.
  lastScanAt: Date | null;
}

const EMPTY_STATS: RepositoryStats = {
  openPullCount: 0,
  openCriticalCount: 0,
  lastScanAt: null,
};

interface CheckedProviderRepo {
  path: string;
  defaultBranch: string;
  language: string | null;
  // Of the branches asked about, those the provider does not have.
  missingBranches: string[];
}

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
    private readonly scanQueue: ScanQueueService,
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
  ) {}

  async getBranchesForCandidate(
    organizationId: string,
    source: Provider,
    providerRepoId: string,
    search?: string,
  ): Promise<BranchListResponseDto> {
    const integration = await this.findIntegrationOrThrow(
      organizationId,
      source,
    );
    const result = await this.fetchProviderBranches(
      integration,
      providerRepoId,
      { search },
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
    search?: string,
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
    assertGithubAccess(repository.integration);

    const result = await this.fetchProviderBranches(
      repository.integration,
      repository.externalId,
      { knownPath: repository.path, search },
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
    const policies = await this.findBranchPolicies(repositoryId);
    return this.toScanConfigDto(scanConfig, policies);
  }

  // Scope and review policy per branch, written together so a branch can
  // never be in scope without a policy (before, a branch added here had
  // none and its PRs fell back to MANUAL_ONLY). A policy change applies to
  // PRs opened afterwards: effectivePolicy is snapshotted on the PR.
  async updateScanConfig(
    organizationId: string,
    repositoryId: string,
    actorUserId: string,
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
    // Deduped too: a branch listed twice would otherwise be stored twice.
    const withoutDefault = trimmed.filter(
      (branch) => branch !== scanConfig.defaultBranch,
    );
    const branches = [
      ...new Set([scanConfig.defaultBranch, ...withoutDefault]),
    ];

    const requested = new Map<string, ReviewPolicy>();
    for (const { branch, policy } of dto.policies ?? []) {
      const name = branch.trim();
      if (requested.has(name)) {
        throw new UnprocessableEntityException({
          field: 'policies',
          message: 'duplicate_policy_branch',
          branch: name,
        });
      }
      if (!branches.includes(name)) {
        throw new UnprocessableEntityException({
          field: 'policies',
          message: 'policy_branch_not_in_scope',
          branch: name,
        });
      }
      requested.set(name, DEFAULT_POLICY_MAP[policy]);
    }

    // A branch added to the scope must exist at the provider, as at connect
    // — Critiq never creates branches. Only added ones are checked: one
    // deleted at the provider since must not block every later save.
    const added = branches.filter(
      (branch) => !scanConfig.branches.includes(branch),
    );
    if (added.length > 0) {
      const unknown = await this.findUnknownBranches(repositoryId, added);
      if (unknown.length > 0) {
        throw new UnprocessableEntityException({
          field: 'branches',
          message: 'unknown_branch',
          branch: unknown[0],
        });
      }
    }

    // Requested → stored → the default branch's → MANUAL_ONLY (the same
    // fallback a PR gets for a branch without a row).
    const current = await this.findBranchPolicies(repositoryId);
    const defaultBranchPolicy =
      requested.get(scanConfig.defaultBranch) ??
      current.get(scanConfig.defaultBranch) ??
      ReviewPolicy.MANUAL_ONLY;
    const next = new Map(
      branches.map((branch) => [
        branch,
        requested.get(branch) ?? current.get(branch) ?? defaultBranchPolicy,
      ]),
    );
    const changed = branches.filter(
      (branch) => current.get(branch) !== next.get(branch),
    );

    const updated = await this.prisma.$transaction(async (tx) => {
      const config = await tx.repoScanConfig.update({
        where: { id: scanConfig.id },
        data: { branches },
      });
      await tx.branchScanPolicy.deleteMany({
        where: { repositoryId, branch: { notIn: branches } },
      });
      for (const branch of changed) {
        const policy = next.get(branch)!;
        await tx.branchScanPolicy.upsert({
          where: { repositoryId_branch: { repositoryId, branch } },
          create: { organizationId, repositoryId, branch, policy },
          update: { policy },
        });
      }
      return config;
    });

    // TODO(audit log model): persisted row once the table exists.
    this.logger.info('audit.repo.scan_config_updated', {
      orgId: organizationId,
      repoId: repositoryId,
      by: actorUserId,
      branches: { before: scanConfig.branches, after: branches },
      policies: changed.map((branch) => ({
        branch,
        before: current.has(branch)
          ? toPolicyWireValue(current.get(branch)!)
          : null,
        after: toPolicyWireValue(next.get(branch)!),
      })),
    });

    return this.toScanConfigDto(updated, next);
  }

  // The branches, of those given, the repository does not have at the
  // provider — checked one by one (branchExists), not against a listed
  // page, like the connect check.
  private async findUnknownBranches(
    repositoryId: string,
    branches: string[],
  ): Promise<string[]> {
    const repository = await this.prisma.repository.findUniqueOrThrow({
      where: { id: repositoryId },
      include: { integration: true },
    });
    const { integration } = repository;
    if (integration.state === IntegrationState.TOKEN_EXPIRED) {
      throw new ConflictException({
        field: 'organizationId',
        message: 'token_expired',
      });
    }
    assertGithubAccess(integration);

    let exists: boolean[];
    if (integration.source === Provider.GITHUB) {
      const installationId = this.githubInstallationId(integration);
      const [owner, repo] = repository.path.split('/');
      exists = await Promise.all(
        branches.map((branch) =>
          this.githubAppService.branchExists(
            installationId,
            owner,
            repo,
            branch,
          ),
        ),
      );
    } else {
      const { instanceUrl, token } = this.gitlabCredential(integration);
      exists = await Promise.all(
        branches.map((branch) =>
          this.gitlabApiService.branchExists(
            instanceUrl,
            token,
            repository.externalId,
            branch,
          ),
        ),
      );
    }
    return branches.filter((_, index) => !exists[index]);
  }

  private async findBranchPolicies(
    repositoryId: string,
  ): Promise<Map<string, ReviewPolicy>> {
    const rows = await this.prisma.branchScanPolicy.findMany({
      where: { repositoryId },
      select: { branch: true, policy: true },
    });
    return new Map(rows.map((row) => [row.branch, row.policy]));
  }

  // One policy per branch in scope, in scope order. A branch without a row
  // (only possible before the backfill migration ran) reports MANUAL_ONLY —
  // what its PRs actually get.
  private toScanConfigDto(
    scanConfig: {
      defaultBranch: string;
      branches: string[];
      defaultBranchChangedAt: Date | null;
    },
    policies: Map<string, ReviewPolicy>,
  ): RepoScanConfigResponseDto {
    return new RepoScanConfigResponseDto({
      defaultBranch: scanConfig.defaultBranch,
      branches: scanConfig.branches,
      policies: scanConfig.branches.map((branch) => ({
        branch,
        policy: toPolicyWireValue(
          policies.get(branch) ?? ReviewPolicy.MANUAL_ONLY,
        ),
      })),
      defaultBranchChangedAt: scanConfig.defaultBranchChangedAt,
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
      let providerRepo: CheckedProviderRepo;
      try {
        providerRepo = await this.checkProviderRepo(
          integration,
          providerRepoId,
          project.monitoredBranches ?? [],
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
        providerRepo.defaultBranch,
      ];
      const unknown = requested.find((branch) =>
        providerRepo.missingBranches.includes(branch),
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

      const monitoredBranches = requested.includes(providerRepo.defaultBranch)
        ? requested
        : [providerRepo.defaultBranch, ...requested];

      const path = providerRepo.path;

      try {
        const created = await this.prisma.$transaction(async (tx) => {
          const repository = await tx.repository.create({
            data: {
              organizationId,
              integrationId: integration.id,
              provider: integration.source,
              externalId: providerRepoId,
              path,
              defaultBranch: providerRepo.defaultBranch,
              language: providerRepo.language,
              languageCheckedAt: new Date(),
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
              defaultBranch: providerRepo.defaultBranch,
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
          defaultBranch: providerRepo.defaultBranch,
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
    const [repositories, stats] = await Promise.all([
      this.prisma.repository.findMany({
        where: { organizationId },
        include: { scanConfig: true },
      }),
      this.repositoryStats(organizationId),
    ]);

    return repositories.map(
      (repository) =>
        new RepositoryListItemDto({
          id: repository.id,
          provider: repository.provider,
          path: repository.path,
          defaultBranch: repository.defaultBranch,
          monitoredBranchCount: repository.scanConfig?.branches.length ?? 0,
          language: repository.language,
          ...(stats.get(repository.id) ?? EMPTY_STATS),
        }),
    );
  }

  // Open PRs, their active criticals and the last finished scan, per
  // repository of the organization — from the database only, no provider
  // call. Two queries for the whole list, not one per repository.
  private async repositoryStats(
    organizationId: string,
    repositoryId?: string,
  ): Promise<Map<string, RepositoryStats>> {
    const scope = repositoryId
      ? { organizationId, repositoryId }
      : { organizationId };
    const [openPulls, lastScans] = await Promise.all([
      this.prisma.pullRequest.findMany({
        where: { ...scope, state: PullRequestState.OPEN },
        select: {
          repositoryId: true,
          latestScan: { select: { criticalCount: true } },
        },
      }),
      this.prisma.scan.groupBy({
        by: ['repositoryId'],
        where: {
          ...scope,
          status: { in: [ScanStatus.DONE, ScanStatus.FAILED] },
        },
        _max: { finishedAt: true },
      }),
    ]);

    const stats = new Map<string, RepositoryStats>();
    const statsFor = (id: string) => {
      const current = stats.get(id) ?? { ...EMPTY_STATS };
      stats.set(id, current);
      return current;
    };
    for (const pull of openPulls) {
      const current = statsFor(pull.repositoryId);
      current.openPullCount += 1;
      current.openCriticalCount += pull.latestScan?.criticalCount ?? 0;
    }
    for (const scan of lastScans) {
      statsFor(scan.repositoryId).lastScanAt = scan._max.finishedAt;
    }
    return stats;
  }

  async getDetail(
    organizationId: string,
    repositoryId: string,
  ): Promise<RepositoryDetailDto> {
    const repository = await this.prisma.repository.findUnique({
      where: { id: repositoryId },
      include: {
        scanConfig: true,
        branchPolicies: { select: { branch: true, policy: true } },
      },
    });
    if (!repository || repository.organizationId !== organizationId) {
      throw new NotFoundException('Repository not found.');
    }
    const stats = await this.repositoryStats(organizationId, repositoryId);

    return new RepositoryDetailDto({
      id: repository.id,
      provider: repository.provider,
      path: repository.path,
      defaultBranch: repository.defaultBranch,
      language: repository.language,
      ...(stats.get(repository.id) ?? EMPTY_STATS),
      scanConfig: repository.scanConfig
        ? this.toScanConfigDto(
            repository.scanConfig,
            new Map(
              repository.branchPolicies.map((row) => [row.branch, row.policy]),
            ),
          )
        : null,
    });
  }

  // Re-runs scans for a repo's open PRs.
  //
  // `staleOnly` is the mode that matters in practice: after a ruleset
  // version bump, PRs that were already scanned keep showing results the
  // old rules produced until someone pushes to them. This lets an admin
  // refresh a repo deliberately, rather than every deploy kicking off a
  // scan wave across every org at once.
  async rescanOpenPulls(
    organizationId: string,
    repositoryId: string,
    staleOnly: boolean,
  ): Promise<RescanResponseDto> {
    const repository = await this.prisma.repository.findUnique({
      where: { id: repositoryId },
      select: { id: true, organizationId: true, provider: true },
    });
    if (!repository || repository.organizationId !== organizationId) {
      throw new NotFoundException('Repository not found.');
    }

    const pulls = await this.prisma.pullRequest.findMany({
      where: { repositoryId, state: PullRequestState.OPEN },
      select: {
        id: true,
        headSha: true,
        latestScan: { select: { rulesetVersion: true } },
      },
    });

    let enqueued = 0;
    let skippedUpToDate = 0;

    for (const pull of pulls) {
      // No head sha means there is no commit to check out — nothing a scan
      // could run against.
      if (!pull.headSha) {
        continue;
      }
      if (staleOnly && pull.latestScan?.rulesetVersion === RULESET_VERSION) {
        skippedUpToDate += 1;
        continue;
      }

      await this.scanQueue.enqueue({
        organizationId,
        repositoryId,
        pullId: pull.id,
        headSha: pull.headSha,
        // Informational only, and unavailable here — the processor diffs
        // against the provider's merge base, not this value.
        baseSha: null,
        provider: repository.provider,
        trigger: ScanTrigger.RESCAN,
      });
      enqueued += 1;
    }

    this.logger.info('repo.rescan_requested', {
      orgId: organizationId,
      repoId: repositoryId,
      staleOnly,
      enqueued,
      skippedUpToDate,
    });
    return new RescanResponseDto({ enqueued, skippedUpToDate });
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
    assertGithubAccess(integration);
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
    integration: ProviderIntegration,
    providerRepoId: string,
    options: { knownPath?: string; search?: string } = {},
  ): Promise<ProviderBranches> {
    const listOptions = { limit: BRANCH_LIST_LIMIT, search: options.search };
    if (integration.source === Provider.GITHUB) {
      const installationId = this.githubInstallationId(integration);
      const [owner, repo] = await this.splitGithubPath(
        options.knownPath,
        installationId,
        providerRepoId,
      );
      const [detail, branchResult] = await Promise.all([
        this.githubAppService.fetchRepository(installationId, owner, repo),
        this.githubAppService.listBranches(
          installationId,
          owner,
          repo,
          listOptions,
        ),
      ]);
      return this.toProviderBranches(
        `${owner}/${repo}`,
        detail.default_branch,
        branchResult,
        options.search,
      );
    }

    const { instanceUrl, token } = this.gitlabCredential(integration);
    const [detail, branchResult] = await Promise.all([
      this.gitlabApiService.fetchProject(instanceUrl, token, providerRepoId),
      this.gitlabApiService.fetchBranches(
        instanceUrl,
        token,
        providerRepoId,
        listOptions,
      ),
    ]);
    return this.toProviderBranches(
      detail.path_with_namespace,
      detail.default_branch,
      branchResult,
      options.search,
    );
  }

  // Resolves a repository and checks the branches a user picked, one
  // request per branch, all in parallel with the repository lookup. Not
  // through the branch list: that is one page, and a branch found with
  // `?search=` is usually outside it.
  private async checkProviderRepo(
    integration: ProviderIntegration,
    providerRepoId: string,
    branches: string[],
  ): Promise<CheckedProviderRepo> {
    if (integration.source === Provider.GITHUB) {
      const installationId = this.githubInstallationId(integration);
      const [owner, repo] = await this.splitGithubPath(
        undefined,
        installationId,
        providerRepoId,
      );
      const [detail, exists] = await Promise.all([
        this.githubAppService.fetchRepository(installationId, owner, repo),
        Promise.all(
          branches.map((branch) =>
            this.githubAppService.branchExists(
              installationId,
              owner,
              repo,
              branch,
            ),
          ),
        ),
      ]);
      return {
        path: `${owner}/${repo}`,
        defaultBranch: detail.default_branch,
        language: detail.language ?? null,
        missingBranches: branches.filter((_, index) => !exists[index]),
      };
    }

    const { instanceUrl, token } = this.gitlabCredential(integration);
    const [detail, language, exists] = await Promise.all([
      this.gitlabApiService.fetchProject(instanceUrl, token, providerRepoId),
      this.gitlabApiService.fetchMainLanguage(
        instanceUrl,
        token,
        providerRepoId,
      ),
      Promise.all(
        branches.map((branch) =>
          this.gitlabApiService.branchExists(
            instanceUrl,
            token,
            providerRepoId,
            branch,
          ),
        ),
      ),
    ]);
    return {
      path: detail.path_with_namespace,
      defaultBranch: detail.default_branch,
      language,
      missingBranches: branches.filter((_, index) => !exists[index]),
    };
  }

  private githubInstallationId(integration: ProviderIntegration): string {
    if (!integration.installationId) {
      throw new Error(
        'Integration row with source GITHUB is missing installationId — data invariant violated.',
      );
    }
    return integration.installationId;
  }

  private gitlabCredential(integration: ProviderIntegration): {
    instanceUrl: string;
    token: string;
  } {
    if (!integration.instanceUrl || !integration.encryptedToken) {
      throw new Error(
        'Integration row with source GITLAB is missing its GitLab credential fields — data invariant violated.',
      );
    }
    return {
      instanceUrl: integration.instanceUrl,
      token: this.encryptionService.decrypt(integration.encryptedToken),
    };
  }

  // The provider's order is kept — most recently updated first on GitLab —
  // with the default branch on top. Unfiltered, the default branch is always
  // there (even when older than the page); searched, only if it matches.
  private toProviderBranches(
    path: string,
    defaultBranch: string,
    branchResult: { branches: { name: string }[]; truncated: boolean },
    search?: string,
  ): ProviderBranches {
    const names = branchResult.branches.map((branch) => branch.name);
    const rest = names.filter((name) => name !== defaultBranch);
    const branches =
      search && !names.includes(defaultBranch)
        ? rest
        : [defaultBranch, ...rest];
    return {
      path,
      defaultBranch,
      branches,
      total: branches.length,
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
