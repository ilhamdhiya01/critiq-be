import { PrismaService } from '../../common/prisma/prisma.service';
import { GithubInstallReturnTo } from '../../generated/prisma/enums';
import { GithubInstallIntentService } from './github-install-intent.service';

jest.mock('../../common/prisma/prisma.service', () => ({
  PrismaService: class {},
}));

function setup(options: {
  intent?: Record<string, unknown> | null;
  organization?: { slug: string } | null;
}) {
  const prisma = {
    githubInstallIntent: {
      findUnique: jest.fn().mockResolvedValue(options.intent ?? null),
      delete: jest.fn().mockResolvedValue(undefined),
    },
    organization: {
      findUnique: jest
        .fn()
        .mockResolvedValue(
          options.organization === undefined
            ? { slug: 'cititex-engineer' }
            : options.organization,
        ),
    },
  };
  const service = new GithubInstallIntentService(
    prisma as unknown as PrismaService,
  );
  return { service, prisma };
}

const intent = (expiresInMs: number) => ({
  state: 's',
  organizationId: 'org_1',
  userId: 'user_1',
  returnTo: GithubInstallReturnTo.SETTINGS,
  expiresAt: new Date(Date.now() + expiresInMs),
});

describe('GithubInstallIntentService.consume', () => {
  it('returns the intent with the org slug, once', async () => {
    const { service, prisma } = setup({ intent: intent(60_000) });

    await expect(service.consume('s')).resolves.toEqual({
      orgId: 'org_1',
      orgSlug: 'cititex-engineer',
      userId: 'user_1',
      returnTo: GithubInstallReturnTo.SETTINGS,
    });
    expect(prisma.githubInstallIntent.delete).toHaveBeenCalledWith({
      where: { state: 's' },
    });
  });

  it('rejects an expired intent, still deleting it', async () => {
    const { service, prisma } = setup({ intent: intent(-1) });
    await expect(service.consume('s')).resolves.toBeNull();
    expect(prisma.githubInstallIntent.delete).toHaveBeenCalled();
  });

  it('rejects an intent whose organization is gone', async () => {
    const { service } = setup({ intent: intent(60_000), organization: null });
    await expect(service.consume('s')).resolves.toBeNull();
  });

  it('rejects an unknown state', async () => {
    const { service, prisma } = setup({ intent: null });
    await expect(service.consume('s')).resolves.toBeNull();
    expect(prisma.githubInstallIntent.delete).not.toHaveBeenCalled();
  });
});
