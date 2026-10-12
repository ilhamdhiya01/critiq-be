import type { Queue } from 'bullmq';
import { Logger } from 'winston';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  CommentKind,
  CommentOrigin,
  CommentSyncStatus,
  DiffSide,
} from '../../generated/prisma/enums';
import type { CommentSyncJobPayload } from '../../queue/comment-sync-queue.constants';
import { CommentsService } from './comments.service';

jest.mock('@nestjs/bullmq', () => ({ InjectQueue: () => () => undefined }));
jest.mock('bullmq', () => ({ Queue: class {} }));
jest.mock('../../common/prisma/prisma.service', () => ({
  PrismaService: class {},
}));

const ORG = 'org_1';
const REPO = 'repo_1';
const HEAD = 'abc123';

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'c1',
    organizationId: ORG,
    pullId: 'pull_1',
    origin: CommentOrigin.CRITIQ,
    kind: CommentKind.GENERAL,
    parentId: null,
    authorId: 'u_1',
    providerAuthor: null,
    providerAuthorAvatarUrl: null,
    body: 'hello',
    path: null,
    line: null,
    side: null,
    headSha: null,
    providerCommentId: null,
    providerThreadId: null,
    syncStatus: CommentSyncStatus.PENDING,
    syncError: null,
    editedAt: null,
    deletedAt: null,
    createdAt: new Date('2026-10-12T05:00:00Z'),
    updatedAt: new Date('2026-10-12T05:00:00Z'),
    author: { id: 'u_1', name: 'Ilham', email: 'i@x.io', avatarUrl: null },
    ...overrides,
  };
}

function setup() {
  const prisma = {
    pullRequest: {
      findUnique: jest.fn().mockResolvedValue({
        organizationId: ORG,
        repositoryId: REPO,
        headSha: HEAD,
      }),
    },
    pullComment: {
      create: jest.fn(
        (args: { data: Record<string, unknown> }): Promise<unknown> =>
          Promise.resolve(row(args.data)),
      ),
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const queue = { add: jest.fn().mockResolvedValue({}) };
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const service = new CommentsService(
    prisma as unknown as PrismaService,
    queue as unknown as Queue<CommentSyncJobPayload>,
    logger as unknown as Logger,
  );
  return { service, prisma, queue };
}

const createData = (prisma: ReturnType<typeof setup>['prisma']) =>
  (
    prisma.pullComment.create.mock.calls[0] as [
      { data: Record<string, unknown> },
    ]
  )[0].data;

describe('CommentsService.create', () => {
  it('stores a general comment and queues its copy', async () => {
    const { service, prisma, queue } = setup();
    const comment = await service.create(ORG, REPO, 'pull_1', 'u_1', {
      body: '  hello  ',
    });
    expect(createData(prisma)).toMatchObject({
      origin: CommentOrigin.CRITIQ,
      kind: CommentKind.GENERAL,
      body: 'hello',
      authorId: 'u_1',
      syncStatus: CommentSyncStatus.PENDING,
      parentId: null,
    });
    expect(queue.add).toHaveBeenCalledWith(
      'sync',
      { commentId: 'c1' },
      expect.objectContaining({ attempts: 4 }),
    );
    expect(comment).toMatchObject({
      origin: 'critiq',
      author: { name: 'Ilham', critiqUserId: 'u_1' },
      sync: { status: 'pending', error: null },
    });
  });

  it('places an inline comment on the head', async () => {
    const { service, prisma } = setup();
    await service.create(ORG, REPO, 'pull_1', 'u_1', {
      body: 'nit',
      inline: { path: 'src/a.ts', line: 155, side: 'new', headSha: HEAD },
    });
    expect(createData(prisma)).toMatchObject({
      kind: CommentKind.INLINE,
      path: 'src/a.ts',
      line: 155,
      side: DiffSide.NEW,
      headSha: HEAD,
    });
  });

  it('409s an inline comment on an older commit', async () => {
    const { service, prisma } = setup();
    await expect(
      service.create(ORG, REPO, 'pull_1', 'u_1', {
        body: 'nit',
        inline: { path: 'a.ts', line: 1, side: 'new', headSha: 'old' },
      }),
    ).rejects.toMatchObject({
      status: 409,
      response: { message: 'head_changed' },
    });
    expect(prisma.pullComment.create).not.toHaveBeenCalled();
  });

  // A reply joins its thread at the root, and takes the thread's place.
  it('threads a reply under the root, with its position', async () => {
    const { service, prisma } = setup();
    const root = row({
      id: 'root',
      kind: CommentKind.INLINE,
      path: 'a.ts',
      line: 9,
      side: DiffSide.NEW,
      headSha: HEAD,
    });
    prisma.pullComment.findUnique.mockResolvedValue(
      row({ id: 'reply', parentId: 'root' }),
    );
    prisma.pullComment.findUniqueOrThrow.mockResolvedValue(root);
    await service.create(ORG, REPO, 'pull_1', 'u_1', {
      body: 'agreed',
      parentId: 'reply',
    });
    expect(createData(prisma)).toMatchObject({
      parentId: 'root',
      kind: CommentKind.INLINE,
      path: 'a.ts',
      line: 9,
    });
  });

  it.each([
    ['a missing parent', null, undefined],
    ['a parent on another PR', row({ pullId: 'pull_other' }), undefined],
    [
      'a reply that also brings a position',
      row(),
      { path: 'a.ts', line: 1, side: 'new' as const, headSha: HEAD },
    ],
  ])('422s %s', async (_label, parent, inline) => {
    const { service, prisma } = setup();
    prisma.pullComment.findUnique.mockResolvedValue(parent);
    await expect(
      service.create(ORG, REPO, 'pull_1', 'u_1', {
        body: 'x',
        parentId: 'c0',
        inline,
      }),
    ).rejects.toMatchObject({ response: { message: 'invalid_parent' } });
  });

  it('marks the copy failed when the queue is unreachable', async () => {
    const { service, queue } = setup();
    queue.add.mockRejectedValue(new Error('ECONNREFUSED'));
    const comment = await service.create(ORG, REPO, 'pull_1', 'u_1', {
      body: 'hello',
    });
    expect(comment.sync).toEqual({ status: 'failed', error: 'unknown' });
  });
});

describe('CommentsService.list', () => {
  it('groups replies under their root and flags outdated inline threads', async () => {
    const { service, prisma } = setup();
    prisma.pullComment.findMany.mockResolvedValue([
      row({
        id: 'r2',
        parentId: 'root',
        createdAt: new Date('2026-10-12T06:00:00Z'),
      }),
      row({
        id: 'root',
        kind: CommentKind.INLINE,
        path: 'a.ts',
        line: 3,
        side: DiffSide.NEW,
        headSha: 'old',
      }),
      row({
        id: 'gh',
        origin: CommentOrigin.GITHUB,
        author: null,
        providerAuthor: 'octo',
        syncStatus: null,
        createdAt: new Date('2026-10-12T07:00:00Z'),
      }),
    ]);
    const { threads } = await service.list(ORG, REPO, 'pull_1');
    expect(
      threads.map((t) => [t.id, t.kind, t.outdated, t.comments.length]),
    ).toEqual([
      ['root', 'inline', true, 2],
      ['gh', 'general', false, 1],
    ]);
    expect(threads[1].comments[0]).toMatchObject({
      origin: 'github',
      author: { name: 'octo', providerUsername: 'octo', critiqUserId: null },
      sync: null,
    });
  });
});

describe('CommentsService.retrySync', () => {
  it('queues a failed copy again', async () => {
    const { service, prisma, queue } = setup();
    prisma.pullComment.findUnique.mockResolvedValue(
      row({ syncStatus: CommentSyncStatus.FAILED, syncError: 'unknown' }),
    );
    await service.retrySync(ORG, REPO, 'pull_1', 'c1');
    expect(queue.add).toHaveBeenCalled();
  });

  it('409s a copy already sent', async () => {
    const { service, prisma } = setup();
    prisma.pullComment.findUnique.mockResolvedValue(
      row({ syncStatus: CommentSyncStatus.SYNCED }),
    );
    await expect(
      service.retrySync(ORG, REPO, 'pull_1', 'c1'),
    ).rejects.toMatchObject({ response: { message: 'already_synced' } });
  });

  it('404s a comment that came from the provider', async () => {
    const { service, prisma } = setup();
    prisma.pullComment.findUnique.mockResolvedValue(
      row({ origin: CommentOrigin.GITHUB, syncStatus: null }),
    );
    await expect(
      service.retrySync(ORG, REPO, 'pull_1', 'c1'),
    ).rejects.toMatchObject({ status: 404 });
  });
});
