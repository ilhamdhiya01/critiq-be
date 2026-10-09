import { ConfigService } from '@nestjs/config';
import { Logger } from 'winston';
import { EncryptionService } from '../../common/encryption/encryption.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  IntegrationState,
  Provider,
  ReviewPolicy,
} from '../../generated/prisma/enums';
import { ScanQueueService } from '../../queue/scan-queue.service';
import { GithubAppService } from '../integrations/github-app.service';
import { GitlabApiService } from '../integrations/gitlab-api.service';
import { ReposService } from './repos.service';

// ESM-only packages reachable through the service's imports.
jest.mock('@nestjs/config', () => ({ ConfigService: class {} }));
jest.mock('@nestjs/axios', () => ({ HttpService: class {} }));
jest.mock('@nestjs/bullmq', () => ({ InjectQueue: () => () => undefined }));
jest.mock('bullmq', () => ({ Queue: class {} }));
jest.mock('../../common/prisma/prisma.service', () => ({
  PrismaService: class {},
}));
jest.mock('../../generated/prisma/client', () => ({
  Prisma: { PrismaClientKnownRequestError: class {} },
}));
jest.mock('../integrations/github-app.service', () => ({
  GithubAppService: class {},
}));

const ORG = 'org_1';
const GITLAB_INTEGRATION = {
  id: 'int_1',
  organizationId: ORG,
  source: Provider.GITLAB,
  state: IntegrationState.ACTIVE,
  installationId: null,
  instanceUrl: 'https://gitlab.com',
  encryptedToken: 'enc',
};

const SCAN_CONFIG = {
  id: 'cfg_1',
  defaultBranch: 'main',
  branches: ['main', 'develop'],
  defaultBranchChangedAt: null,
};

function setup() {
  const tx = {
    repository: { create: jest.fn().mockResolvedValue({ id: 'repo_1' }) },
    organization: { update: jest.fn() },
    repoScanConfig: {
      create: jest.fn(),
      update: jest.fn((args: { data: { branches: string[] } }) =>
        Promise.resolve({ ...SCAN_CONFIG, branches: args.data.branches }),
      ),
    },
    branchScanPolicy: {
      createMany: jest.fn(),
      deleteMany: jest.fn(),
      upsert: jest.fn(),
    },
  };
  const prisma = {
    integration: {
      findUnique: jest.fn().mockResolvedValue(GITLAB_INTEGRATION),
    },
    repository: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'repo_1',
        organizationId: ORG,
        provider: Provider.GITLAB,
        path: 'acme/erp',
        defaultBranch: 'main',
        language: 'PHP',
        scanConfig: SCAN_CONFIG,
        branchPolicies: [],
      }),
      // The scan-config branch check reads the repo with its integration.
      findUniqueOrThrow: jest.fn().mockResolvedValue({
        id: 'repo_1',
        path: 'acme/erp',
        externalId: '42',
        integration: GITLAB_INTEGRATION,
      }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    pullRequest: { findMany: jest.fn().mockResolvedValue([]) },
    scan: { groupBy: jest.fn().mockResolvedValue([]) },
    branchScanPolicy: {
      findMany: jest.fn().mockResolvedValue([
        { branch: 'main', policy: ReviewPolicy.REQUIRE_BOTH },
        { branch: 'develop', policy: ReviewPolicy.ALLOW_AI },
      ]),
    },
    $transaction: jest.fn((fn: (client: typeof tx) => unknown) => fn(tx)),
  };
  const gitlab = {
    fetchProject: jest.fn().mockResolvedValue({
      id: 42,
      path_with_namespace: 'acme/erp',
      default_branch: 'master',
    }),
    fetchMainLanguage: jest.fn().mockResolvedValue('PHP'),
    fetchBranches: jest.fn(),
    branchExists: jest.fn().mockResolvedValue(true),
  };
  const logger = { warn: jest.fn(), info: jest.fn() };
  const service = new ReposService(
    prisma as unknown as PrismaService,
    { decrypt: () => 'token' } as unknown as EncryptionService,
    {} as GithubAppService,
    gitlab as unknown as GitlabApiService,
    {} as ConfigService,
    {} as ScanQueueService,
    logger as unknown as Logger,
  );
  jest
    .spyOn(
      service as unknown as { installWebhook: () => Promise<unknown> },
      'installWebhook',
    )
    .mockResolvedValue({ status: 'installed' });
  return { service, gitlab, tx, prisma, logger };
}

const branches = (...list: string[]) => list.map((name) => ({ name }));

describe('ReposService branch list', () => {
  it('keeps the provider order (most recent first) with the default on top', async () => {
    const { service, gitlab } = setup();
    gitlab.fetchBranches.mockResolvedValue({
      branches: branches('1578-new', '174-pabrik', 'master', '1577-stock'),
      truncated: true,
    });

    const result = await service.getBranchesForCandidate(
      ORG,
      Provider.GITLAB,
      '42',
    );

    expect(gitlab.fetchBranches).toHaveBeenCalledWith(
      'https://gitlab.com',
      'token',
      '42',
      { limit: 50, search: undefined },
    );
    // Not re-sorted by name — that would undo "most recently updated".
    expect(result.branches).toEqual([
      'master',
      '1578-new',
      '174-pabrik',
      '1577-stock',
    ]);
    expect(result.truncated).toBe(true);
  });

  it('always lists the default branch, even when older than the page', async () => {
    const { service, gitlab } = setup();
    gitlab.fetchBranches.mockResolvedValue({
      branches: branches('1578-new'),
      truncated: true,
    });
    const result = await service.getBranchesForCandidate(
      ORG,
      Provider.GITLAB,
      '42',
    );
    expect(result.branches).toEqual(['master', '1578-new']);
  });

  it('searches server-side and lists the default only when it matches', async () => {
    const { service, gitlab } = setup();
    gitlab.fetchBranches.mockResolvedValue({
      branches: branches('1578-new-sewing-machine-list'),
      truncated: false,
    });

    const result = await service.getBranchesForCandidate(
      ORG,
      Provider.GITLAB,
      '42',
      '1578',
    );

    expect(gitlab.fetchBranches).toHaveBeenCalledWith(
      'https://gitlab.com',
      'token',
      '42',
      { limit: 50, search: '1578' },
    );
    expect(result.branches).toEqual(['1578-new-sewing-machine-list']);
    expect(result.total).toBe(1);
  });

  // The App was removed or suspended on GitHub: no token can be minted, and
  // the FE needs to know which, not a generic installation_invalid.
  it.each([
    [IntegrationState.UNINSTALLED, 'github_uninstalled'],
    [IntegrationState.SUSPENDED, 'github_suspended'],
  ])('409s when the GitHub App is %s', async (state, message) => {
    const { service, prisma } = setup();
    prisma.integration.findUnique.mockResolvedValue({
      ...GITLAB_INTEGRATION,
      source: Provider.GITHUB,
      installationId: '169478542',
      state,
    });
    await expect(
      service.getBranchesForCandidate(ORG, Provider.GITHUB, '42'),
    ).rejects.toMatchObject({ status: 409, response: { message } });
  });
});

describe('ReposService.createRepos branch check', () => {
  // A branch found with ?search= is outside the listed page; connecting it
  // used to fail with unknown_branch.
  it('accepts a branch outside any listed page, checked on its own', async () => {
    const { service, gitlab, tx } = setup();
    gitlab.branchExists.mockResolvedValue(true);

    const result = await service.createRepos(ORG, {
      source: 'gitlab',
      defaultPolicy: 'require_both',
      projects: [
        { id: 42, monitoredBranches: ['1578-new-sewing-machine-list'] },
      ],
    } as never);

    expect(gitlab.fetchBranches).not.toHaveBeenCalled();
    expect(gitlab.branchExists).toHaveBeenCalledWith(
      'https://gitlab.com',
      'token',
      '42',
      '1578-new-sewing-machine-list',
    );
    expect(result.items[0]).toMatchObject({
      status: 'ok',
      monitoredBranches: ['master', '1578-new-sewing-machine-list'],
    });
    expect(tx.repository.create).toHaveBeenCalled();
  });

  it('rejects a branch the provider does not have', async () => {
    const { service, gitlab, tx } = setup();
    gitlab.branchExists.mockImplementation(
      (_url: string, _token: string, _id: string, branch: string) =>
        Promise.resolve(branch !== 'gone'),
    );

    const result = await service.createRepos(ORG, {
      source: 'gitlab',
      defaultPolicy: 'require_both',
      projects: [{ id: 42, monitoredBranches: ['develop', 'gone'] }],
    } as never);

    expect(result.items[0]).toEqual({
      status: 'failed',
      providerRepoId: 42,
      error: 'unknown_branch',
      branch: 'gone',
    });
    expect(tx.repository.create).not.toHaveBeenCalled();
  });

  it('needs no branch check when only the default branch is monitored', async () => {
    const { service, gitlab } = setup();
    const result = await service.createRepos(ORG, {
      source: 'gitlab',
      defaultPolicy: 'require_both',
      projects: [{ id: 42 }],
    } as never);
    expect(gitlab.branchExists).not.toHaveBeenCalled();
    expect(result.items[0]).toMatchObject({
      status: 'ok',
      monitoredBranches: ['master'],
    });
  });
});

// Review policy per branch, edited after connect. Before, a branch added
// to the scope had no policy row and its PRs silently fell back to
// MANUAL_ONLY.
describe('ReposService scan config policies', () => {
  it('returns one policy per branch in scope order', async () => {
    const { service } = setup();
    const config = await service.getScanConfig(ORG, 'repo_1');
    expect(config.policies).toEqual([
      { branch: 'main', policy: 'require_both' },
      { branch: 'develop', policy: 'allow_ai' },
    ]);
  });

  it('changes a policy and writes only what changed', async () => {
    const { service, tx } = setup();
    const config = await service.updateScanConfig(ORG, 'repo_1', 'u_1', {
      branches: ['main', 'develop'],
      policies: [
        { branch: 'main', policy: 'require_both' },
        { branch: 'develop', policy: 'manual_only' },
      ],
    });
    expect(tx.branchScanPolicy.upsert).toHaveBeenCalledTimes(1);
    expect(tx.branchScanPolicy.upsert).toHaveBeenCalledWith({
      where: {
        repositoryId_branch: { repositoryId: 'repo_1', branch: 'develop' },
      },
      create: {
        organizationId: ORG,
        repositoryId: 'repo_1',
        branch: 'develop',
        policy: ReviewPolicy.MANUAL_ONLY,
      },
      update: { policy: ReviewPolicy.MANUAL_ONLY },
    });
    expect(config.policies).toContainEqual({
      branch: 'develop',
      policy: 'manual_only',
    });
  });

  it("gives a new branch the default branch's policy", async () => {
    const { service, tx } = setup();
    const config = await service.updateScanConfig(ORG, 'repo_1', 'u_1', {
      branches: ['main', 'develop', 'staging'],
    });
    expect(tx.branchScanPolicy.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          branch: 'staging',
          policy: ReviewPolicy.REQUIRE_BOTH,
        }) as unknown,
      }),
    );
    expect(config.policies.map((p) => p.policy)).toEqual([
      'require_both',
      'allow_ai',
      'require_both',
    ]);
  });

  it('removes the policy of a branch taken out of scope', async () => {
    const { service, tx } = setup();
    await service.updateScanConfig(ORG, 'repo_1', 'u_1', {
      branches: ['main'],
    });
    expect(tx.branchScanPolicy.deleteMany).toHaveBeenCalledWith({
      where: { repositoryId: 'repo_1', branch: { notIn: ['main'] } },
    });
  });

  // The old body (branches only) keeps every stored policy.
  it('keeps policies when the body has none', async () => {
    const { service, tx } = setup();
    const config = await service.updateScanConfig(ORG, 'repo_1', 'u_1', {
      branches: ['main', 'develop'],
    });
    expect(tx.branchScanPolicy.upsert).not.toHaveBeenCalled();
    expect(config.policies).toEqual([
      { branch: 'main', policy: 'require_both' },
      { branch: 'develop', policy: 'allow_ai' },
    ]);
  });

  it('stores a branch listed twice once', async () => {
    const { service, tx } = setup();
    await service.updateScanConfig(ORG, 'repo_1', 'u_1', {
      branches: ['develop', 'develop'],
    });
    expect(tx.repoScanConfig.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { branches: ['main', 'develop'] } }),
    );
  });

  it.each([
    [
      [{ branch: 'release', policy: 'allow_ai' as const }],
      'policy_branch_not_in_scope',
    ],
    [
      [
        { branch: 'main', policy: 'allow_ai' as const },
        { branch: 'main', policy: 'manual_only' as const },
      ],
      'duplicate_policy_branch',
    ],
  ])('422s %j', async (policies, message) => {
    const { service, tx } = setup();
    await expect(
      service.updateScanConfig(ORG, 'repo_1', 'u_1', {
        branches: ['main', 'develop'],
        policies,
      }),
    ).rejects.toMatchObject({ status: 422, response: { message } });
    expect(tx.repoScanConfig.update).not.toHaveBeenCalled();
  });

  it('audits who changed which policy, before and after', async () => {
    const { service, logger } = setup();
    await service.updateScanConfig(ORG, 'repo_1', 'u_1', {
      branches: ['main', 'develop', 'staging'],
      policies: [{ branch: 'develop', policy: 'manual_only' }],
    });
    expect(logger.info).toHaveBeenCalledWith(
      'audit.repo.scan_config_updated',
      expect.objectContaining({
        by: 'u_1',
        branches: {
          before: ['main', 'develop'],
          after: ['main', 'develop', 'staging'],
        },
        policies: [
          { branch: 'develop', before: 'allow_ai', after: 'manual_only' },
          { branch: 'staging', before: null, after: 'require_both' },
        ],
      }),
    );
  });

  // Critiq never creates branches: one added to the scope must exist at the
  // provider, as at connect.
  it('422s a new branch the provider does not have', async () => {
    const { service, gitlab, tx } = setup();
    gitlab.branchExists.mockImplementation(
      (_url: string, _token: string, _id: string, branch: string) =>
        Promise.resolve(branch !== 'ghost'),
    );
    await expect(
      service.updateScanConfig(ORG, 'repo_1', 'u_1', {
        branches: ['main', 'develop', 'staging', 'ghost'],
      }),
    ).rejects.toMatchObject({
      status: 422,
      response: { message: 'unknown_branch', branch: 'ghost' },
    });
    expect(tx.repoScanConfig.update).not.toHaveBeenCalled();
  });

  // A branch already in scope may have been deleted at the provider since;
  // checking it again would block every later save.
  it('checks only the branches being added', async () => {
    const { service, gitlab } = setup();
    await service.updateScanConfig(ORG, 'repo_1', 'u_1', {
      branches: ['main', 'develop', 'staging'],
    });
    expect(gitlab.branchExists).toHaveBeenCalledTimes(1);
    expect(gitlab.branchExists).toHaveBeenCalledWith(
      'https://gitlab.com',
      'token',
      '42',
      'staging',
    );
  });

  it('asks the provider nothing when no branch is added', async () => {
    const { service, gitlab, prisma } = setup();
    await service.updateScanConfig(ORG, 'repo_1', 'u_1', {
      branches: ['main'],
      policies: [{ branch: 'main', policy: 'allow_ai' }],
    });
    expect(prisma.repository.findUniqueOrThrow).not.toHaveBeenCalled();
    expect(gitlab.branchExists).not.toHaveBeenCalled();
  });

  it('404s a repository from another organization', async () => {
    const { service } = setup();
    await expect(
      service.updateScanConfig('org_other', 'repo_1', 'u_1', {
        branches: ['main'],
      }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

// The repositories list and detail: language plus open PRs, their active
// criticals and the last finished scan — from the database only.
describe('ReposService repository stats', () => {
  const repoRow = (id: string) => ({
    id,
    organizationId: ORG,
    provider: Provider.GITLAB,
    path: `acme/${id}`,
    defaultBranch: 'main',
    language: id === 'repo_1' ? 'PHP' : null,
    scanConfig: SCAN_CONFIG,
  });

  it('sums open PRs and their latest criticals per repository', async () => {
    const { service, prisma } = setup();
    const lastScan = new Date('2026-10-09T03:00:00Z');
    prisma.repository.findMany.mockResolvedValue([
      repoRow('repo_1'),
      repoRow('repo_2'),
    ]);
    prisma.pullRequest.findMany.mockResolvedValue([
      { repositoryId: 'repo_1', latestScan: { criticalCount: 2 } },
      { repositoryId: 'repo_1', latestScan: { criticalCount: 1 } },
      // Not scanned yet: counted as an open PR, adds no criticals.
      { repositoryId: 'repo_1', latestScan: null },
    ]);
    prisma.scan.groupBy.mockResolvedValue([
      { repositoryId: 'repo_1', _max: { finishedAt: lastScan } },
    ]);

    const [first, second] = await service.list(ORG);

    expect(first).toMatchObject({
      language: 'PHP',
      openPullCount: 3,
      openCriticalCount: 3,
      lastScanAt: lastScan,
    });
    expect(second).toMatchObject({
      language: null,
      openPullCount: 0,
      openCriticalCount: 0,
      lastScanAt: null,
    });
  });

  // Closed/merged PRs and other organizations never count; only finished
  // scans set lastScanAt.
  it('reads open PRs and finished scans of this organization only', async () => {
    const { service, prisma } = setup();
    await service.list(ORG);
    expect(prisma.pullRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: ORG, state: 'OPEN' },
      }),
    );
    expect(prisma.scan.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: ORG,
          status: { in: ['DONE', 'FAILED'] },
        },
      }),
    );
  });

  it('scopes the detail to its repository', async () => {
    const { service, prisma } = setup();
    prisma.pullRequest.findMany.mockResolvedValue([
      { repositoryId: 'repo_1', latestScan: { criticalCount: 1 } },
    ]);
    const detail = await service.getDetail(ORG, 'repo_1');
    expect(prisma.pullRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: ORG, repositoryId: 'repo_1', state: 'OPEN' },
      }),
    );
    expect(detail).toMatchObject({
      language: 'PHP',
      openPullCount: 1,
      openCriticalCount: 1,
    });
  });

  it('stores the language read at connect', async () => {
    const { service, tx } = setup();
    await service.createRepos(ORG, {
      source: 'gitlab',
      defaultPolicy: 'allow_ai',
      projects: [{ id: 42 }],
    } as never);
    expect(tx.repository.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        language: 'PHP',
        languageCheckedAt: expect.any(Date) as Date,
      }) as unknown,
    });
  });
});
