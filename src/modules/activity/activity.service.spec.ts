import { BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ReviewDecision, ReviewSyncStatus } from '../../generated/prisma/enums';
import {
  ActivityService,
  decodeCursor,
  encodeCursor,
} from './activity.service';

jest.mock('../../common/prisma/prisma.service', () => ({
  PrismaService: class {},
}));

const ORG = 'org_1';
const T = new Date('2026-10-19T08:00:00.123Z');

function reviewRow(id: string, createdAt: Date = T) {
  return {
    id,
    decision: ReviewDecision.APPROVE,
    aiAssisted: true,
    syncStatus: ReviewSyncStatus.SYNCED,
    createdAt,
    reviewer: { id: 'u_1', name: null, email: 'p@x.io', avatarUrl: null },
    pullRequest: {
      id: 'pull_1',
      externalId: '479',
      title: 'Terraform modules',
      repositoryId: 'repo_1',
      repository: { path: 'acme/infra-terraform' },
    },
  };
}

function setup(rows: unknown[] = []) {
  const prisma = {
    pullReview: {
      findMany: jest.fn().mockResolvedValue(rows),
      groupBy: jest.fn().mockResolvedValue([
        { decision: ReviewDecision.APPROVE, _count: { _all: 5 } },
        { decision: ReviewDecision.REQUEST_CHANGES, _count: { _all: 7 } },
      ]),
    },
  };
  const service = new ActivityService(prisma as unknown as PrismaService);
  return { service, prisma };
}

type Args = { where: Record<string, unknown>; take?: number };
const findArgs = (prisma: ReturnType<typeof setup>['prisma']) =>
  (prisma.pullReview.findMany.mock.calls[0] as [Args])[0];
const groupArgs = (prisma: ReturnType<typeof setup>['prisma']) =>
  (prisma.pullReview.groupBy.mock.calls[0] as [Args])[0];

describe('ActivityService.list', () => {
  it('pages newest first, 20 by default, with the same item as the dashboard', async () => {
    const { service, prisma } = setup([reviewRow('rev_1')]);
    const page = await service.list(ORG, {});
    expect(prisma.pullReview.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: ORG },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 21,
      }),
    );
    expect(page.items[0]).toMatchObject({
      id: 'rev_1',
      decision: 'approve',
      aiAssisted: true,
      sync: { status: 'synced' },
      reviewer: { name: 'p@x.io' },
      pull: { number: '479', repoPath: 'acme/infra-terraform' },
    });
    expect(page.nextCursor).toBeNull();
  });

  it('hands out a cursor only when another page exists', async () => {
    const rows = ['rev_3', 'rev_2', 'rev_1'].map((id) => reviewRow(id));
    const { service } = setup(rows);
    const page = await service.list(ORG, { limit: 2 });
    expect(page.items.map((item) => item.id)).toEqual(['rev_3', 'rev_2']);
    expect(decodeCursor(page.nextCursor!)).toEqual({
      createdAt: T,
      id: 'rev_2',
    });
  });

  // Several reviews can share a timestamp: the id breaks the tie, so the
  // next page neither repeats nor skips them.
  it('continues strictly after the cursor', async () => {
    const { service, prisma } = setup();
    await service.list(ORG, {
      cursor: encodeCursor({ createdAt: T, id: 'rev_2' }),
    });
    expect(findArgs(prisma).where).toEqual({
      organizationId: ORG,
      OR: [{ createdAt: { lt: T } }, { createdAt: T, id: { lt: 'rev_2' } }],
    });
  });

  it('filters by decision and mode', async () => {
    const { service, prisma } = setup();
    await service.list(ORG, { decision: 'request_changes', mode: 'manual' });
    expect(findArgs(prisma).where).toEqual({
      organizationId: ORG,
      aiAssisted: false,
      decision: ReviewDecision.REQUEST_CHANGES,
    });
  });

  // The tabs keep their numbers whichever tab is open.
  it('counts per decision under the mode filter only', async () => {
    const { service, prisma } = setup();
    const page = await service.list(ORG, {
      decision: 'approve',
      mode: 'ai_assisted',
    });
    expect(groupArgs(prisma).where).toEqual({
      organizationId: ORG,
      aiAssisted: true,
    });
    expect(page.counts).toEqual({ all: 12, approve: 5, request_changes: 7 });
  });

  it('counts zero for a decision with no reviews', async () => {
    const { service, prisma } = setup();
    prisma.pullReview.groupBy.mockResolvedValue([]);
    const page = await service.list(ORG, {});
    expect(page.counts).toEqual({ all: 0, approve: 0, request_changes: 0 });
  });

  it.each(['not-a-cursor', encodeCursor({ createdAt: T, id: '' }), '!!'])(
    'rejects a malformed cursor %p with 400',
    async (cursor) => {
      const { service, prisma } = setup();
      const attempt = service.list(ORG, { cursor });
      await expect(attempt).rejects.toBeInstanceOf(BadRequestException);
      await expect(attempt).rejects.toMatchObject({
        response: { message: 'invalid_cursor' },
      });
      expect(prisma.pullReview.findMany).not.toHaveBeenCalled();
    },
  );
});

describe('activity cursor', () => {
  it('round-trips with millisecond precision', () => {
    const position = { createdAt: T, id: 'cmabc123' };
    expect(decodeCursor(encodeCursor(position))).toEqual(position);
  });
});
