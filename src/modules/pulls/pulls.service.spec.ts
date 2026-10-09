import { Logger } from 'winston';
import { EncryptionService } from '../../common/encryption/encryption.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { Provider } from '../../generated/prisma/enums';
import { GithubAppService } from '../integrations/github-app.service';
import { GitlabApiService } from '../integrations/gitlab-api.service';
import { ScansService } from '../scans/scans.service';
import { PullsService } from './pulls.service';

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
  };
  const github = {
    fetchRepository: jest
      .fn()
      .mockResolvedValue({ default_branch: 'main', language: 'TypeScript' }),
  };
  const gitlab = { fetchMainLanguage: jest.fn().mockResolvedValue('PHP') };
  const service = new PullsService(
    prisma as unknown as PrismaService,
    github as unknown as GithubAppService,
    gitlab as unknown as GitlabApiService,
    { decrypt: () => 'token' } as unknown as EncryptionService,
    {} as ScansService,
    { info: jest.fn(), warn: jest.fn() } as unknown as Logger,
  );
  return { service, prisma, github, gitlab };
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
