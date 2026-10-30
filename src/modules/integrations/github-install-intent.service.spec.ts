import { PrismaService } from '../../common/prisma/prisma.service';
import { GithubInstallReturnTo } from '../../generated/prisma/enums';
import { Prisma } from '../../generated/prisma/client';
import { GithubInstallIntentService } from './github-install-intent.service';

jest.mock('../../common/prisma/prisma.service', () => ({
  PrismaService: class {},
}));
// The generated client cannot load under this Jest setup; only the error
// class is used.
jest.mock('../../generated/prisma/client', () => ({
  Prisma: {
    PrismaClientKnownRequestError: class extends Error {
      constructor(
        message: string,
        readonly options: { code: string },
      ) {
        super(message);
      }
      get code() {
        return this.options.code;
      }
    },
  },
}));

// Prisma's "record to delete does not exist".
function notFound() {
  return new Prisma.PrismaClientKnownRequestError('not found', {
    code: 'P2025',
  } as never);
}

function setup(options: {
  intent?: Record<string, unknown> | null;
  organization?: { slug: string } | null;
}) {
  const prisma = {
    // delete returns the row it removed; a missing row is P2025.
    githubInstallIntent: {
      delete: jest.fn(() =>
        options.intent
          ? Promise.resolve(options.intent)
          : Promise.reject(notFound()),
      ),
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

  // Also the loser of two concurrent callbacks with the same state.
  it('rejects an unknown or already consumed state', async () => {
    const { service } = setup({ intent: null });
    await expect(service.consume('s')).resolves.toBeNull();
  });

  it('lets other database errors through', async () => {
    const { service, prisma } = setup({ intent: null });
    prisma.githubInstallIntent.delete.mockRejectedValue(new Error('down'));
    await expect(service.consume('s')).rejects.toThrow('down');
  });
});
