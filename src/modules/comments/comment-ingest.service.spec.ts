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
import { RealtimePublisher } from '../../common/realtime/realtime.publisher';

jest.mock('../../common/realtime/realtime.publisher', () => ({
  RealtimePublisher: class {},
}));

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
  const realtime = {
    publish: jest.fn(),
    scanChanged: jest.fn(),
    reviewChanged: jest.fn(),
    commentChanged: jest.fn(),
  };
  const service = new CommentIngestService(
    prisma as unknown as PrismaService,
    { info: jest.fn() } as unknown as Logger,
    realtime as unknown as RealtimePublisher,
  );
  return { realtime, service, prisma };
}

const created = (prisma: ReturnType<typeof setup>['prisma']) =>
  (
    prisma.pullComment.create.mock.calls[0] as [
      { data: Record<string, unknown> },
    ]
  )[0].data;

describe('CommentIngestService', () => {
  it('records a provider comment under its author', async () => {
    const { service, prisma, realtime } = setup();
    prisma.pullComment.create.mockResolvedValue({ id: 'c9' });
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
    expect(realtime.publish).toHaveBeenCalledWith({
      type: 'comment.updated',
      orgId: 'org_1',
      repoId: 'repo_1',
      pullId: 'pull_1',
      commentId: 'c9',
      change: 'created',
    });
  });

  it('ignores a comment on a PR Critiq does not track', async () => {
    const { service, prisma, realtime } = setup();
    prisma.pullRequest.findUnique.mockResolvedValue(null);
    await expect(service.ingest(event())).resolves.toBe('ignored');
    expect(prisma.pullComment.create).not.toHaveBeenCalled();
    expect(realtime.publish).not.toHaveBeenCalled();
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

  // comment-sync stored the provider id first; GitHub's `created` for our
  // own comment then arrives. Not an edit: the Critiq text stays as written.
  it('ignores the created echo of a comment already linked', async () => {
    const { service, prisma } = setup();
    prisma.pullComment.findUnique.mockResolvedValue({
      id: 'c1',
      origin: CommentOrigin.CRITIQ,
      kind: CommentKind.GENERAL,
      parentId: 'root',
      body: 'udah mas',
    });
    await expect(
      service.ingest(
        event({
          body: providerBody('Ilham', 'udah mas', 'c1', 'ini udah di cek ?'),
        }),
      ),
    ).resolves.toBe('linked');
    expect(prisma.pullComment.update).not.toHaveBeenCalled();
  });

  // A general reply goes to GitHub quoting its root; an edit made there
  // must not bring Critiq's quote back into the text.
  it('drops the quote Critiq added when a GitHub reply is edited', async () => {
    const { service, prisma } = setup();
    prisma.pullComment.findUnique.mockResolvedValue({
      id: 'c1',
      origin: CommentOrigin.CRITIQ,
      kind: CommentKind.GENERAL,
      parentId: 'root',
      body: 'udah mas',
    });
    await service.ingest(
      event({
        action: 'edited',
        body: providerBody(
          'Ilham',
          'udah mas, sudah dicek',
          'c1',
          'ini udah di cek ?',
        ).replace(/\n/g, '\r\n'),
      }),
    );
    expect(prisma.pullComment.update).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: {
        body: 'udah mas, sudah dicek',
        editedAt: expect.any(Date) as Date,
      },
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
