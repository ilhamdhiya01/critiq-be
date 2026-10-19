import { Logger } from 'winston';
import { EncryptionService } from '../../common/encryption/encryption.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { Provider } from '../../generated/prisma/enums';
import { GithubAppService } from '../integrations/github-app.service';
import { GitlabApiService } from '../integrations/gitlab-api.service';
import { ScansService } from '../scans/scans.service';
import { PullsService, parseProviderTime } from './pulls.service';
import { RealtimePublisher } from '../../common/realtime/realtime.publisher';

jest.mock('../../common/realtime/realtime.publisher', () => ({
  RealtimePublisher: class {},
}));

// ESM-only packages reachable through the service's imports; every
// collaborator is a plain stub below.
jest.mock('@nestjs/config', () => ({ ConfigService: class {} }));
jest.mock('../../common/prisma/prisma.service', () => ({
  PrismaService: class {},
}));
jest.mock('../integrations/github-app.service', () => ({
  GithubAppService: class {},
}));
jest.mock('../integrations/gitlab-api.service', () => ({
  GitlabApiService: class {},
}));
jest.mock('../scans/scans.service', () => ({ ScansService: class {} }));

const GITHUB_REPO = {
  id: 'repo_1',
  organizationId: 'org_1',
  path: 'acme/web-console',
  externalId: '42',
  languageCheckedAt: null,
  integration: {
    source: Provider.GITHUB,
    installationId: '169478542',
    instanceUrl: null,
    encryptedToken: null,
  },
};

function setup(repository: Record<string, unknown> | null = GITHUB_REPO) {
  const prisma = {
    repository: {
      findUnique: jest.fn().mockResolvedValue(repository),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    pullRequest: { findUnique: jest.fn(), upsert: jest.fn() },
    branchScanPolicy: {
      findUnique: jest.fn().mockResolvedValue({ policy: 'ALLOW_AI' }),
    },
  };
  const github = {
    fetchRepository: jest
      .fn()
      .mockResolvedValue({ default_branch: 'main', language: 'TypeScript' }),
  };
  const gitlab = { fetchMainLanguage: jest.fn().mockResolvedValue('PHP') };
  const realtime = {
    publish: jest.fn(),
    scanChanged: jest.fn(),
    reviewChanged: jest.fn(),
    commentChanged: jest.fn(),
  };
  const service = new PullsService(
    prisma as unknown as PrismaService,
    github as unknown as GithubAppService,
    gitlab as unknown as GitlabApiService,
    { decrypt: () => 'token' } as unknown as EncryptionService,
    {} as ScansService,
    { info: jest.fn(), warn: jest.fn() } as unknown as Logger,
    realtime as unknown as RealtimePublisher,
  );
  return { realtime, service, prisma, github, gitlab };
}

// Repositories connected before Repository.language existed: asked once,
// on the worker's next scan of them.
describe('PullsService.fillMissingLanguage', () => {
  it('stores the GitHub language once', async () => {
    const { service, prisma, github } = setup();
    await service.fillMissingLanguage('org_1', 'repo_1');
    expect(github.fetchRepository).toHaveBeenCalledWith(
      '169478542',
      'acme',
      'web-console',
    );
    expect(prisma.repository.updateMany).toHaveBeenCalledWith({
      where: { id: 'repo_1', languageCheckedAt: null },
      data: {
        language: 'TypeScript',
        languageCheckedAt: expect.any(Date) as Date,
      },
    });
  });

  it("stores GitLab's top language", async () => {
    const { service, prisma, gitlab } = setup({
      ...GITHUB_REPO,
      integration: {
        source: Provider.GITLAB,
        installationId: null,
        instanceUrl: 'https://gitlab.com',
        encryptedToken: 'enc',
      },
    });
    await service.fillMissingLanguage('org_1', 'repo_1');
    expect(gitlab.fetchMainLanguage).toHaveBeenCalledWith(
      'https://gitlab.com',
      'token',
      '42',
    );
    expect(prisma.repository.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ language: 'PHP' }) as unknown,
      }),
    );
  });

  it('asks the provider nothing once checked', async () => {
    const { service, prisma, github } = setup({
      ...GITHUB_REPO,
      languageCheckedAt: new Date(),
    });
    await service.fillMissingLanguage('org_1', 'repo_1');
    expect(github.fetchRepository).not.toHaveBeenCalled();
    expect(prisma.repository.updateMany).not.toHaveBeenCalled();
  });

  it('ignores a repository of another organization', async () => {
    const { service, prisma, github } = setup();
    await service.fillMissingLanguage('org_other', 'repo_1');
    expect(github.fetchRepository).not.toHaveBeenCalled();
    expect(prisma.repository.updateMany).not.toHaveBeenCalled();
  });

  // A GitHub failure leaves the repository unchecked for the next scan.
  it('marks nothing when GitHub fails', async () => {
    const { service, prisma, github } = setup();
    github.fetchRepository.mockRejectedValue(new Error('down'));
    await expect(
      service.fillMissingLanguage('org_1', 'repo_1'),
    ).rejects.toThrow('down');
    expect(prisma.repository.updateMany).not.toHaveBeenCalled();
  });
});

// Realtime: every webhook upsert tells open tabs, and whether the diff moved.
describe('PullsService.upsertFromWebhook', () => {
  const payload = (sha: string) => ({
    action: 'synchronize',
    pull_request: {
      number: 7,
      title: 'Add login',
      body: null,
      user: { login: 'octo' },
      state: 'open',
      merged: false,
      head: { ref: 'feature', sha },
      base: { ref: 'main' },
      created_at: '2026-10-19T01:00:00Z',
    },
  });

  it.each([
    ['a push', 'old', true],
    ['an edit of the title', 'new', false],
  ])('announces %s', async (_case, previousSha, headChanged) => {
    const { service, prisma, realtime } = setup();
    prisma.pullRequest.findUnique.mockResolvedValue({ headSha: previousSha });
    prisma.pullRequest.upsert.mockResolvedValue({
      id: 'pull_1',
      state: 'OPEN',
      headSha: 'new',
    });

    await service.upsertFromWebhook(
      'org_1',
      'repo_1',
      Provider.GITHUB,
      payload('new') as never,
    );

    expect(realtime.publish).toHaveBeenCalledWith({
      type: 'pull.updated',
      orgId: 'org_1',
      repoId: 'repo_1',
      pullId: 'pull_1',
      state: 'OPEN',
      headChanged,
    });
  });

  // The dashboard's turnaround counts from when the PR was opened.
  it('stores when the PR was opened on the provider', async () => {
    const { service, prisma } = setup();
    prisma.pullRequest.findUnique.mockResolvedValue(null);
    prisma.pullRequest.upsert.mockResolvedValue({
      id: 'pull_1',
      state: 'OPEN',
      headSha: 'new',
    });
    await service.upsertFromWebhook(
      'org_1',
      'repo_1',
      Provider.GITHUB,
      payload('new') as never,
    );
    const [args] = prisma.pullRequest.upsert.mock.calls[0] as [
      { create: { openedAt: Date }; update: { openedAt: Date } },
    ];
    const opened = new Date('2026-10-19T01:00:00Z');
    expect(args.create.openedAt).toEqual(opened);
    expect(args.update.openedAt).toEqual(opened);
  });
});

describe('parseProviderTime', () => {
  it.each([
    ['2026-10-19T01:00:00Z', '2026-10-19T01:00:00.000Z'],
    ['2026-10-19T08:00:00.000+07:00', '2026-10-19T01:00:00.000Z'],
    // Older GitLab instances.
    ['2026-10-19 01:00:00 UTC', '2026-10-19T01:00:00.000Z'],
  ])('reads %s', (value, iso) => {
    expect(parseProviderTime(value)?.toISOString()).toBe(iso);
  });

  it.each([undefined, '', 'not a date'])('is null for %p', (value) => {
    expect(parseProviderTime(value)).toBeNull();
  });
});
