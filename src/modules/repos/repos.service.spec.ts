import { ConfigService } from '@nestjs/config';
import { Logger } from 'winston';
import { EncryptionService } from '../../common/encryption/encryption.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { IntegrationState, Provider } from '../../generated/prisma/enums';
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

function setup() {
  const tx = {
    repository: { create: jest.fn().mockResolvedValue({ id: 'repo_1' }) },
    organization: { update: jest.fn() },
    repoScanConfig: { create: jest.fn() },
    branchScanPolicy: { createMany: jest.fn() },
  };
  const prisma = {
    integration: {
      findUnique: jest.fn().mockResolvedValue(GITLAB_INTEGRATION),
    },
    $transaction: jest.fn((fn: (client: typeof tx) => unknown) => fn(tx)),
  };
  const gitlab = {
    fetchProject: jest.fn().mockResolvedValue({
      id: 42,
      path_with_namespace: 'acme/erp',
      default_branch: 'master',
    }),
    fetchBranches: jest.fn(),
    branchExists: jest.fn(),
  };
  const service = new ReposService(
    prisma as unknown as PrismaService,
    { decrypt: () => 'token' } as unknown as EncryptionService,
    {} as GithubAppService,
    gitlab as unknown as GitlabApiService,
    {} as ConfigService,
    {} as ScanQueueService,
    { warn: jest.fn(), info: jest.fn() } as unknown as Logger,
  );
  jest
    .spyOn(
      service as unknown as { installWebhook: () => Promise<unknown> },
      'installWebhook',
    )
    .mockResolvedValue({ status: 'installed' });
  return { service, gitlab, tx };
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
