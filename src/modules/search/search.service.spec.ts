import { PrismaService } from '../../common/prisma/prisma.service';
import { PullRequestState } from '../../generated/prisma/enums';
import { SearchService, escapeLike } from './search.service';

jest.mock('../../common/prisma/prisma.service', () => ({
  PrismaService: class {},
}));

const ORG = 'org_1';

function setup() {
  const prisma = {
    repository: { findMany: jest.fn().mockResolvedValue([]) },
    pullRequest: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const service = new SearchService(prisma as unknown as PrismaService);
  return { service, prisma };
}

type Where = { where: Record<string, unknown>; take?: number };
const callArgs = (mock: jest.Mock, index = 0) =>
  (mock.mock.calls[index] as [Where])[0];

describe('escapeLike', () => {
  // Prisma's contains does not escape: typed wildcards must stay literal.
  it.each([
    ['100%', '100\\%'],
    ['dark_mode', 'dark\\_mode'],
    ['back\\slash', 'back\\\\slash'],
    ['plain', 'plain'],
  ])('%s → %s', (value, escaped) => {
    expect(escapeLike(value)).toBe(escaped);
  });
});

describe('SearchService.search', () => {
  it('matches repositories by path, with their open criticals', async () => {
    const { service, prisma } = setup();
    prisma.repository.findMany.mockResolvedValue([
      { id: 'r1', path: 'acme/payments-api', language: 'TypeScript' },
    ]);
    prisma.pullRequest.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { repositoryId: 'r1', latestScan: { criticalCount: 3 } },
        { repositoryId: 'r1', latestScan: null },
      ]);
    const results = await service.search(ORG, ' Payments ');
    expect(callArgs(prisma.repository.findMany)).toMatchObject({
      where: {
        organizationId: ORG,
        path: { contains: 'Payments', mode: 'insensitive' },
      },
      take: 5,
    });
    expect(callArgs(prisma.pullRequest.findMany, 1).where).toEqual({
      organizationId: ORG,
      repositoryId: { in: ['r1'] },
      state: PullRequestState.OPEN,
    });
    expect(results.repositories).toEqual([
      {
        id: 'r1',
        path: 'acme/payments-api',
        language: 'TypeScript',
        openCriticalCount: 3,
      },
    ]);
  });

  it('finds a PR by number, open ones first', async () => {
    const { service, prisma } = setup();
    prisma.pullRequest.findMany.mockResolvedValueOnce([
      {
        id: 'p1',
        repositoryId: 'r1',
        externalId: '482',
        title: 'Refactor auth token refresh',
        state: PullRequestState.OPEN,
        updatedAt: new Date('2026-10-20T00:00:00Z'),
        repository: { path: 'acme/payments-api' },
      },
    ]);
    const results = await service.search(ORG, '#482', 3);
    const args = callArgs(prisma.pullRequest.findMany) as Where & {
      orderBy: unknown;
    };
    expect(args.where).toMatchObject({
      organizationId: ORG,
      OR: expect.arrayContaining([{ externalId: '482' }]) as unknown,
    });
    expect(args.orderBy).toEqual([{ state: 'asc' }, { updatedAt: 'desc' }]);
    expect(args.take).toBe(3);
    expect(results.pulls).toEqual([
      {
        id: 'p1',
        repoId: 'r1',
        repoPath: 'acme/payments-api',
        number: '482',
        title: 'Refactor auth token refresh',
        state: 'open',
        updatedAt: new Date('2026-10-20T00:00:00Z'),
      },
    ]);
  });

  it('does not treat words as PR numbers', async () => {
    const { service, prisma } = setup();
    await service.search(ORG, 'auth');
    const { OR } = callArgs(prisma.pullRequest.findMany).where as {
      OR: object[];
    };
    expect(OR).toHaveLength(3);
  });

  it('finds tiers and static rules without the database', async () => {
    const { service } = setup();
    const { rules } = await service.search(ORG, 'breaking');
    expect(rules).toEqual([
      {
        kind: 'tier',
        id: 'breaking_change',
        label: 'Breaking change',
        tier: 'breaking_change',
      },
    ]);
    const debuggerRule = (await service.search(ORG, 'debugger')).rules;
    expect(debuggerRule).toEqual([
      {
        kind: 'rule',
        id: 'code.debugger_left',
        label: 'Debugger breakpoint left in code',
        tier: 'crash',
      },
    ]);
    expect((await service.search(ORG, 'syntax')).rules[0]).toMatchObject({
      id: 'code.syntax_error',
      tier: 'crash',
    });
  });

  it('skips the open-critical lookup when no repository matches', async () => {
    const { service, prisma } = setup();
    await service.search(ORG, 'nothing');
    expect(prisma.pullRequest.findMany).toHaveBeenCalledTimes(1);
  });
});
