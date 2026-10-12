import { Logger } from 'winston';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  CommentKind,
  CommentOrigin,
  DiffSide,
  Provider,
} from '../../generated/prisma/enums';
import { CommentIngestService, InboundComment } from './comment-ingest.service';
import { providerBody } from './comment-marker';

jest.mock('../../common/prisma/prisma.service', () => ({
  PrismaService: class {},
}));

const event = (overrides: Partial<InboundComment> = {}): InboundComment => ({
  provider: Provider.GITHUB,
  repositoryExternalId: '42',
  pullExternalId: '7',
  action: 'created',
  providerCommentId: 'github-issue:900',
  providerThreadKey: null,
  kind: CommentKind.GENERAL,
  path: null,
  line: null,
  side: null,
  headSha: null,
  body: 'Looks good',
  author: 'octo',
  avatarUrl: null,
  createdAt: new Date('2026-10-12T05:00:00Z'),
  ...overrides,
});

function setup() {
  const prisma = {
    repository: {
      findFirst: jest
        .fn()
        .mockResolvedValue({ id: 'repo_1', organizationId: 'org_1' }),
    },
    pullRequest: { findUnique: jest.fn().mockResolvedValue({ id: 'pull_1' }) },
    pullComment: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
      findUniqueOrThrow: jest.fn(),
      create: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
    },
  };
  const service = new CommentIngestService(
    prisma as unknown as PrismaService,
    { info: jest.fn() } as unknown as Logger,
  );
  return { service, prisma };
}

const created = (prisma: ReturnType<typeof setup>['prisma']) =>
  (
    prisma.pullComment.create.mock.calls[0] as [
      { data: Record<string, unknown> },
    ]
  )[0].data;

describe('CommentIngestService', () => {
  it('records a provider comment under its author', async () => {
    const { service, prisma } = setup();
    await expect(service.ingest(event())).resolves.toBe('created');
    expect(created(prisma)).toMatchObject({
      organizationId: 'org_1',
      pullId: 'pull_1',
      origin: CommentOrigin.GITHUB,
      providerAuthor: 'octo',
      providerCommentId: 'github-issue:900',
      parentId: null,
      kind: CommentKind.GENERAL,
    });
  });

  it('ignores a comment on a PR Critiq does not track', async () => {
    const { service, prisma } = setup();
    prisma.pullRequest.findUnique.mockResolvedValue(null);
    await expect(service.ingest(event())).resolves.toBe('ignored');
    expect(prisma.pullComment.create).not.toHaveBeenCalled();
  });

  // Anti-echo: our own comment coming back links instead of copying.
  it('links its own comment instead of creating a copy', async () => {
    const { service, prisma } = setup();
    prisma.pullComment.findUnique.mockImplementation(
      (args: { where: { id?: string } }) =>
        Promise.resolve(
          args.where.id === 'c1'
            ? { id: 'c1', pullId: 'pull_1', providerCommentId: null }
            : null,
        ),
    );
    await expect(
      service.ingest(event({ body: providerBody('Ilham', 'hi', 'c1') })),
    ).resolves.toBe('linked');
    expect(prisma.pullComment.update).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: { providerCommentId: 'github-issue:900' },
    });
    expect(prisma.pullComment.create).not.toHaveBeenCalled();
  });

  it('updates an edited comment, keeping a Critiq author', async () => {
    const { service, prisma } = setup();
    prisma.pullComment.findUnique.mockResolvedValue({
      id: 'c1',
      origin: CommentOrigin.CRITIQ,
      body: 'hi',
    });
    await expect(
      service.ingest(
        event({
          action: 'edited',
          body: providerBody('Ilham', 'hi there', 'c1'),
        }),
      ),
    ).resolves.toBe('updated');
    expect(prisma.pullComment.update).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: { body: 'hi there', editedAt: expect.any(Date) as Date },
    });
  });

  it('marks a deleted comment', async () => {
    const { service, prisma } = setup();
    prisma.pullComment.findUnique.mockResolvedValue({ id: 'c1' });
    await expect(service.ingest(event({ action: 'deleted' }))).resolves.toBe(
      'deleted',
    );
    expect(prisma.pullComment.update).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: { deletedAt: expect.any(Date) as Date },
    });
  });

  // GitHub names the comment replied to; the reply joins that thread.
  it('threads a GitHub review reply under its root', async () => {
    const { service, prisma } = setup();
    prisma.pullComment.findFirst.mockResolvedValue({
      id: 'root',
      parentId: null,
      kind: CommentKind.INLINE,
      path: 'a.ts',
      line: 12,
      side: DiffSide.NEW,
      headSha: 'abc',
      providerThreadId: 'github-review:800',
    });
    await service.ingest(
      event({
        providerCommentId: 'github-review:901',
        providerThreadKey: 'github-review:800',
        kind: CommentKind.INLINE,
        path: 'a.ts',
        line: 12,
        side: DiffSide.NEW,
      }),
    );
    expect(created(prisma)).toMatchObject({
      parentId: 'root',
      providerThreadId: 'github-review:800',
      kind: CommentKind.INLINE,
    });
  });

  // GitLab's first note of a discussion starts the thread.
  it('starts a thread for the first note of a GitLab discussion', async () => {
    const { service, prisma } = setup();
    await service.ingest(
      event({
        provider: Provider.GITLAB,
        providerCommentId: 'gitlab-note:55',
        providerThreadKey: 'gitlab-discussion:d1',
      }),
    );
    expect(created(prisma)).toMatchObject({
      origin: CommentOrigin.GITLAB,
      parentId: null,
      providerThreadId: 'gitlab-discussion:d1',
    });
  });
});
