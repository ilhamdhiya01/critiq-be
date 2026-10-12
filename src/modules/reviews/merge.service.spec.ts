import { Logger } from 'winston';
import { EncryptionService } from '../../common/encryption/encryption.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  IntegrationState,
  Provider,
  PullRequestState,
  ReviewDecision,
  Role,
  ScanStatus,
} from '../../generated/prisma/enums';
import { ScanQueueService } from '../../queue/scan-queue.service';
import { GithubAppService } from '../integrations/github-app.service';
import { GitlabApiService } from '../integrations/gitlab-api.service';
import { ProviderMergeError } from '../integrations/provider-merge-error';
import { MergeService } from './merge.service';

jest.mock('../../common/prisma/prisma.service', () => ({
  PrismaService: class {},
}));
jest.mock('../../common/encryption/encryption.service', () => ({
  EncryptionService: class {},
}));
jest.mock('../../queue/scan-queue.service', () => ({
  ScanQueueService: class {},
}));
jest.mock('../integrations/github-app.service', () => ({
  GithubAppService: class {},
}));
jest.mock('../integrations/gitlab-api.service', () => ({
  GitlabApiService: class {},
}));

const ORG = 'org_1';
const REPO = 'repo_1';
const HEAD = 'abc123';

const GITHUB = {
  source: Provider.GITHUB,
  state: IntegrationState.ACTIVE,
  installationId: '169478542',
  instanceUrl: null,
  encryptedToken: null,
};

function pullRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pull_1',
    organizationId: ORG,
    repositoryId: REPO,
    externalId: '12',
    headSha: HEAD,
    sourceBranch: 'feature',
    state: PullRequestState.OPEN,
    latestScan: { status: ScanStatus.DONE, headSha: HEAD, criticalCount: 0 },
    repository: { path: 'acme/web', externalId: '42', integration: GITHUB },
    ...overrides,
  };
}

function setup(
  pull: Record<string, unknown> = pullRow(),
  role: Role = Role.REVIEWER,
) {
  const prisma = {
    pullRequest: {
      findUnique: jest.fn().mockResolvedValue(pull),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    membership: { findUniqueOrThrow: jest.fn().mockResolvedValue({ role }) },
    pullReview: {
      findMany: jest
        .fn()
        .mockResolvedValue([
          { reviewerId: 'u_2', decision: ReviewDecision.APPROVE },
        ]),
    },
  };
  const github = {
    mergePullRequest: jest.fn().mockResolvedValue(undefined),
    deleteBranch: jest.fn().mockResolvedValue(true),
  };
  const gitlab = { mergeMergeRequest: jest.fn().mockResolvedValue(undefined) };
  const scanQueue = { cancelPending: jest.fn().mockResolvedValue(0) };
  const logger = { info: jest.fn(), warn: jest.fn() };
  const service = new MergeService(
    prisma as unknown as PrismaService,
    { decrypt: () => 'token' } as unknown as EncryptionService,
    github as unknown as GithubAppService,
    gitlab as unknown as GitlabApiService,
    scanQueue as unknown as ScanQueueService,
    logger as unknown as Logger,
  );
  return { service, prisma, github, gitlab, scanQueue, logger };
}

const withCritical = (count = 2) =>
  pullRow({
    latestScan: {
      status: ScanStatus.DONE,
      headSha: HEAD,
      criticalCount: count,
    },
  });

describe('MergeService.merge', () => {
  it('merges on GitHub as the App, pinned to the head', async () => {
    const { service, prisma, github, scanQueue, logger } = setup();

    const result = await service.merge(ORG, REPO, 'pull_1', 'u_1', {
      headSha: HEAD,
      method: 'squash',
      deleteSourceBranch: true,
    });

    expect(github.mergePullRequest).toHaveBeenCalledWith(
      '169478542',
      'acme',
      'web',
      '12',
      { sha: HEAD, method: 'squash' },
    );
    expect(github.deleteBranch).toHaveBeenCalledWith(
      '169478542',
      'acme',
      'web',
      'feature',
    );
    expect(prisma.pullRequest.updateMany).toHaveBeenCalledWith({
      where: { id: 'pull_1', state: PullRequestState.OPEN },
      data: { state: PullRequestState.MERGED },
    });
    expect(scanQueue.cancelPending).toHaveBeenCalledWith('pull_1');
    expect(logger.info).toHaveBeenCalledWith(
      'audit.pull.merged',
      expect.objectContaining({ by: 'u_1', method: 'squash' }),
    );
    expect(result).toMatchObject({ state: 'merged', method: 'squash' });
  });

  it('merges on GitLab with squash and branch removal flags', async () => {
    const { service, gitlab } = setup(
      pullRow({
        repository: {
          path: 'acme/web',
          externalId: '42',
          integration: {
            ...GITHUB,
            source: Provider.GITLAB,
            installationId: null,
            instanceUrl: 'https://gitlab.com',
            encryptedToken: 'enc',
          },
        },
      }),
    );
    await service.merge(ORG, REPO, 'pull_1', 'u_1', { headSha: HEAD });
    expect(gitlab.mergeMergeRequest).toHaveBeenCalledWith(
      'https://gitlab.com',
      'token',
      '42',
      '12',
      { sha: HEAD, squash: false, removeSourceBranch: false },
    );
  });

  it('409s a stale head', async () => {
    const { service, github } = setup();
    await expect(
      service.merge(ORG, REPO, 'pull_1', 'u_1', { headSha: 'old' }),
    ).rejects.toMatchObject({
      status: 409,
      response: { message: 'head_changed' },
    });
    expect(github.mergePullRequest).not.toHaveBeenCalled();
  });

  it('422s with every blocker, the first as the message', async () => {
    const { service, prisma, github } = setup(withCritical());
    prisma.pullReview.findMany.mockResolvedValue([]);
    await expect(
      service.merge(ORG, REPO, 'pull_1', 'u_1', { headSha: HEAD }),
    ).rejects.toMatchObject({
      status: 422,
      response: {
        message: 'approval_required',
        blockers: ['approval_required', 'critical_findings'],
      },
    });
    expect(github.mergePullRequest).not.toHaveBeenCalled();
  });

  it('blocks critical findings for a Reviewer', async () => {
    const { service } = setup(withCritical());
    await expect(
      service.merge(ORG, REPO, 'pull_1', 'u_1', { headSha: HEAD }),
    ).rejects.toMatchObject({
      response: { message: 'critical_findings' },
    });
  });

  it('refuses a Reviewer the override', async () => {
    const { service } = setup(withCritical());
    await expect(
      service.merge(ORG, REPO, 'pull_1', 'u_1', {
        headSha: HEAD,
        overrideCritical: { reason: 'hotfix' },
      }),
    ).rejects.toMatchObject({
      status: 403,
      response: { message: 'override_requires_admin' },
    });
  });

  it('lets an Admin merge over critical findings, with the reason audited', async () => {
    const { service, github, logger } = setup(withCritical(), Role.ADMIN);
    await service.merge(ORG, REPO, 'pull_1', 'u_1', {
      headSha: HEAD,
      overrideCritical: { reason: 'production hotfix' },
    });
    expect(github.mergePullRequest).toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      'audit.pull.merged',
      expect.objectContaining({
        overrideCritical: true,
        reason: 'production hotfix',
      }),
    );
  });

  // The override only skips critical findings, never a missing approval.
  it('still needs an approval with the override', async () => {
    const { service, prisma } = setup(withCritical(), Role.ADMIN);
    prisma.pullReview.findMany.mockResolvedValue([]);
    await expect(
      service.merge(ORG, REPO, 'pull_1', 'u_1', {
        headSha: HEAD,
        overrideCritical: { reason: 'hotfix' },
      }),
    ).rejects.toMatchObject({
      response: { blockers: ['approval_required'] },
    });
  });

  it.each([
    ['head_changed', 409],
    ['not_mergeable', 422],
    ['insufficient_permission', 403],
    ['provider_unreachable', 502],
  ] as const)('answers a provider %s with %i', async (code, status) => {
    const { service, github, prisma } = setup();
    github.mergePullRequest.mockRejectedValue(
      new ProviderMergeError(code, 'Merge conflict'),
    );
    await expect(
      service.merge(ORG, REPO, 'pull_1', 'u_1', { headSha: HEAD }),
    ).rejects.toMatchObject({ status, response: { message: code } });
    expect(prisma.pullRequest.updateMany).not.toHaveBeenCalled();
  });

  it('shows the provider reason when it is not mergeable', async () => {
    const { service, github } = setup();
    github.mergePullRequest.mockRejectedValue(
      new ProviderMergeError('not_mergeable', 'Required status check missing'),
    );
    await expect(
      service.merge(ORG, REPO, 'pull_1', 'u_1', { headSha: HEAD }),
    ).rejects.toMatchObject({
      response: { detail: 'Required status check missing' },
    });
  });

  it('does not call the provider with an uninstalled App', async () => {
    const { service, github } = setup(
      pullRow({
        repository: {
          path: 'acme/web',
          externalId: '42',
          integration: { ...GITHUB, state: IntegrationState.UNINSTALLED },
        },
      }),
    );
    await expect(
      service.merge(ORG, REPO, 'pull_1', 'u_1', { headSha: HEAD }),
    ).rejects.toMatchObject({
      status: 403,
      response: { message: 'insufficient_permission' },
    });
    expect(github.mergePullRequest).not.toHaveBeenCalled();
  });

  it('404s a PR of another organization', async () => {
    const { service } = setup(pullRow({ organizationId: 'org_other' }));
    await expect(
      service.merge(ORG, REPO, 'pull_1', 'u_1', { headSha: HEAD }),
    ).rejects.toMatchObject({ status: 404 });
  });
});
