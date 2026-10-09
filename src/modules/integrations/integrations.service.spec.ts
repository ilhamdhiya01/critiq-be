import { HttpException, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Logger } from 'winston';
import { EncryptionService } from '../../common/encryption/encryption.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { IntegrationState, Provider } from '../../generated/prisma/enums';
import { GithubAppService } from './github-app.service';
import { GitlabApiService } from './gitlab-api.service';
import { IntegrationsService } from './integrations.service';

jest.mock('@nestjs/config', () => ({ ConfigService: class {} }));
jest.mock('../../common/prisma/prisma.service', () => ({
  PrismaService: class {},
}));
jest.mock('../../common/encryption/encryption.service', () => ({
  EncryptionService: class {},
}));
// The generated client's `.js` re-exports do not resolve under ts-jest; the
// service only uses Prisma's error class from it.
jest.mock('../../generated/prisma/client', () => ({
  Prisma: { PrismaClientKnownRequestError: class extends Error {} },
}));
jest.mock('./github-app.service', () => ({ GithubAppService: class {} }));
jest.mock('./gitlab-api.service', () => ({ GitlabApiService: class {} }));

function githubIntegration(overrides: Record<string, unknown> = {}) {
  return {
    id: 'int_gh',
    organizationId: 'org_1',
    source: Provider.GITHUB,
    state: IntegrationState.ACTIVE,
    installationId: '169478542',
    installationLogin: 'acme',
    _count: { repositories: 2 },
    ...overrides,
  };
}

function setup(integration: Record<string, unknown> | null) {
  const prisma = {
    integration: {
      findUnique: jest.fn().mockResolvedValue(integration),
      delete: jest.fn().mockResolvedValue({}),
    },
  };
  const githubAppService = {
    deleteInstallation: jest.fn().mockResolvedValue(undefined),
    listInstallationRepositories: jest.fn().mockResolvedValue([]),
  };
  const logger = { info: jest.fn(), warn: jest.fn() };
  const service = new IntegrationsService(
    prisma as unknown as PrismaService,
    {} as EncryptionService,
    {} as ConfigService,
    githubAppService as unknown as GithubAppService,
    {} as GitlabApiService,
    logger as unknown as Logger,
  );
  return { service, prisma, githubAppService, logger };
}

describe('IntegrationsService.disconnectGithub', () => {
  it('uninstalls on GitHub, then deletes the integration', async () => {
    const { service, prisma, githubAppService, logger } =
      setup(githubIntegration());

    await service.disconnectGithub('org_1', 'u_1');

    expect(githubAppService.deleteInstallation).toHaveBeenCalledWith(
      '169478542',
    );
    expect(prisma.integration.delete).toHaveBeenCalledWith({
      where: { id: 'int_gh' },
    });
    const uninstallOrder =
      githubAppService.deleteInstallation.mock.invocationCallOrder[0];
    const deleteOrder = prisma.integration.delete.mock.invocationCallOrder[0];
    expect(uninstallOrder).toBeLessThan(deleteOrder);
    expect(logger.info).toHaveBeenCalledWith(
      'audit.integration.github_disconnected',
      expect.objectContaining({ orgId: 'org_1', by: 'u_1', repositories: 2 }),
    );
  });

  it('only looks up its own organization', async () => {
    const { service, prisma } = setup(githubIntegration());
    await service.disconnectGithub('org_1', 'u_1');
    expect(prisma.integration.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId_source: {
            organizationId: 'org_1',
            source: Provider.GITHUB,
          },
        },
      }),
    );
  });

  // The installation may still have access: forgetting it would hide that.
  it('deletes nothing when GitHub cannot uninstall', async () => {
    const { service, prisma, githubAppService } = setup(githubIntegration());
    githubAppService.deleteInstallation.mockRejectedValue(
      new HttpException(
        { message: 'github_unreachable' },
        HttpStatus.BAD_GATEWAY,
      ),
    );

    await expect(
      service.disconnectGithub('org_1', 'u_1'),
    ).rejects.toMatchObject({ status: HttpStatus.BAD_GATEWAY });
    expect(prisma.integration.delete).not.toHaveBeenCalled();
  });

  // Uninstalled on GitHub first: deleteInstallation absorbs GitHub's 404.
  it('still disconnects an integration GitHub already uninstalled', async () => {
    const { service, prisma } = setup(
      githubIntegration({ state: IntegrationState.UNINSTALLED }),
    );
    await service.disconnectGithub('org_1', 'u_1');
    expect(prisma.integration.delete).toHaveBeenCalled();
  });

  it('404s without a GitHub integration', async () => {
    const { service, githubAppService } = setup(null);
    await expect(
      service.disconnectGithub('org_1', 'u_1'),
    ).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND });
    expect(githubAppService.deleteInstallation).not.toHaveBeenCalled();
  });
});

describe('IntegrationsService.listGithubCandidates', () => {
  it.each([
    [IntegrationState.UNINSTALLED, 'github_uninstalled'],
    [IntegrationState.SUSPENDED, 'github_suspended'],
  ])('409s when the App is %s on GitHub', async (state, message) => {
    const { service, githubAppService } = setup(githubIntegration({ state }));
    await expect(service.listGithubCandidates('org_1')).rejects.toMatchObject({
      status: HttpStatus.CONFLICT,
      response: { message },
    });
    expect(
      githubAppService.listInstallationRepositories,
    ).not.toHaveBeenCalled();
  });
});
