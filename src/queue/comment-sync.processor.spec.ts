import type { Job } from 'bullmq';
import { Logger } from 'winston';
import { EncryptionService } from '../common/encryption/encryption.service';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  CommentKind,
  CommentSyncStatus,
  DiffSide,
  IntegrationState,
  Provider,
} from '../generated/prisma/enums';
import { GithubAppService } from '../modules/integrations/github-app.service';
import { GitlabApiService } from '../modules/integrations/gitlab-api.service';
import { ProviderCommentError } from '../modules/integrations/provider-comment-error';
import { CommentSyncProcessor } from './comment-sync.processor';
import type { CommentSyncJobPayload } from './comment-sync-queue.constants';

jest.mock('@nestjs/bullmq', () => ({
  Processor: () => () => undefined,
  WorkerHost: class {},
}));
jest.mock('../common/prisma/prisma.service', () => ({
  PrismaService: class {},
}));
jest.mock('../common/encryption/encryption.service', () => ({
  EncryptionService: class {},
}));
jest.mock('../modules/integrations/github-app.service', () => ({
  GithubAppService: class {},
}));
jest.mock('../modules/integrations/gitlab-api.service', () => ({
  GitlabApiService: class {},
}));

interface IntegrationRow {
  source: Provider;
  state: IntegrationState;
  installationId: string | null;
  instanceUrl: string | null;
  encryptedToken: string | null;
}
const GITHUB: IntegrationRow = {
  source: Provider.GITHUB,
  state: IntegrationState.ACTIVE,
  installationId: '1',
  instanceUrl: null,
  encryptedToken: null,
};
const GITLAB: IntegrationRow = {
  source: Provider.GITLAB,
  state: IntegrationState.ACTIVE,
  installationId: null,
  instanceUrl: 'https://gitlab.com',
  encryptedToken: 'enc',
};

function commentRow(
  overrides: Record<string, unknown> = {},
  integration: IntegrationRow = GITHUB,
) {
  return {
    id: 'c1',
    organizationId: 'org_1',
    pullId: 'pull_1',
    kind: CommentKind.GENERAL,
    body: 'hello',
    path: null,
    line: null,
    side: null,
    headSha: null,
    syncStatus: CommentSyncStatus.PENDING,
    author: { name: 'Ilham', email: 'i@x.io' },
    parent: null,
    pullRequest: {
      externalId: '12',
      repository: { path: 'acme/web', externalId: '42', integration },
    },
    ...overrides,
  };
}

function setup(row: unknown = commentRow()) {
  const prisma = {
    pullComment: {
      findUnique: jest.fn().mockResolvedValue(row),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const github = {
    createIssueComment: jest.fn().mockResolvedValue({ id: 900 }),
    createReviewComment: jest.fn().mockResolvedValue({ id: 800 }),
    replyToReviewComment: jest.fn().mockResolvedValue({ id: 801 }),
  };
  const gitlab = {
    fetchMergeRequestDiffRefs: jest.fn().mockResolvedValue({
      base_sha: 'b',
      start_sha: 's',
      head_sha: 'h',
    }),
    createDiscussion: jest
      .fn()
      .mockResolvedValue({ discussionId: 'd1', noteId: 55 }),
    addDiscussionNote: jest.fn().mockResolvedValue({ noteId: 56 }),
  };
  const processor = new CommentSyncProcessor(
    prisma as unknown as PrismaService,
    { decrypt: () => 'token' } as unknown as EncryptionService,
    github as unknown as GithubAppService,
    gitlab as unknown as GitlabApiService,
    { info: jest.fn(), warn: jest.fn() } as unknown as Logger,
  );
  return { processor, prisma, github, gitlab };
}

const job = (attemptsMade = 0) =>
  ({
    data: { commentId: 'c1' },
    attemptsMade,
    opts: { attempts: 4 },
  }) as unknown as Job<CommentSyncJobPayload>;

const lastUpdate = (prisma: ReturnType<typeof setup>['prisma']) =>
  (
    prisma.pullComment.updateMany.mock.calls.at(-1) as [
      { data: Record<string, unknown> },
    ]
  )[0].data;

const body = '**Ilham** via Critiq:\n\nhello\n\n<!-- critiq:comment:c1 -->';

describe('CommentSyncProcessor — GitHub', () => {
  it('posts a general comment in the conversation', async () => {
    const { processor, prisma, github } = setup();
    await processor.process(job());
    expect(github.createIssueComment).toHaveBeenCalledWith(
      '1',
      'acme',
      'web',
      '12',
      body,
    );
    expect(lastUpdate(prisma)).toMatchObject({
      syncStatus: CommentSyncStatus.SYNCED,
      providerCommentId: 'github-issue:900',
      providerThreadId: null,
    });
  });

  // GitHub's PR conversation has no threads: a reply quotes its root.
  it('quotes the root in a general reply', async () => {
    const { processor, github } = setup(
      commentRow({ parent: { body: 'root text', providerThreadId: null } }),
    );
    await processor.process(job());
    expect(github.createIssueComment).toHaveBeenCalledWith(
      '1',
      'acme',
      'web',
      '12',
      expect.stringContaining('> root text'),
    );
  });

  it('starts an inline thread on the line', async () => {
    const { processor, prisma, github } = setup(
      commentRow({
        kind: CommentKind.INLINE,
        path: 'a.ts',
        line: 155,
        side: DiffSide.OLD,
        headSha: 'abc',
      }),
    );
    await processor.process(job());
    expect(github.createReviewComment).toHaveBeenCalledWith(
      '1',
      'acme',
      'web',
      '12',
      { body, commitId: 'abc', path: 'a.ts', line: 155, side: 'LEFT' },
    );
    expect(lastUpdate(prisma)).toMatchObject({
      providerCommentId: 'github-review:800',
      providerThreadId: 'github-review:800',
    });
  });

  it('replies inside an inline thread', async () => {
    const { processor, github } = setup(
      commentRow({
        kind: CommentKind.INLINE,
        parent: { body: 'x', providerThreadId: 'github-review:800' },
      }),
    );
    await processor.process(job());
    expect(github.replyToReviewComment).toHaveBeenCalledWith(
      '1',
      'acme',
      'web',
      '12',
      800,
      body,
    );
  });

  // The thread has not reached GitHub yet: wait for it (retried).
  it('retries a reply whose thread is not synced', async () => {
    const { processor, prisma } = setup(
      commentRow({
        kind: CommentKind.INLINE,
        parent: { body: 'x', providerThreadId: null },
      }),
    );
    await expect(processor.process(job(0))).rejects.toMatchObject({
      code: 'parent_not_synced',
    });
    expect(prisma.pullComment.updateMany).not.toHaveBeenCalled();
  });

  it('fails at once on a position GitHub rejects', async () => {
    const { processor, prisma, github } = setup(
      commentRow({
        kind: CommentKind.INLINE,
        path: 'a.ts',
        line: 1,
        headSha: 'abc',
      }),
    );
    github.createReviewComment.mockRejectedValue(
      new ProviderCommentError('invalid_position', false),
    );
    await processor.process(job());
    expect(lastUpdate(prisma)).toEqual({
      syncStatus: CommentSyncStatus.FAILED,
      syncError: 'invalid_position',
    });
  });
});

describe('CommentSyncProcessor — GitLab', () => {
  it('starts a general discussion', async () => {
    const { processor, prisma, gitlab } = setup(commentRow({}, GITLAB));
    await processor.process(job());
    expect(gitlab.createDiscussion).toHaveBeenCalledWith(
      'https://gitlab.com',
      'token',
      '42',
      '12',
      body,
      undefined,
    );
    expect(lastUpdate(prisma)).toMatchObject({
      providerCommentId: 'gitlab-note:55',
      providerThreadId: 'gitlab-discussion:d1',
    });
  });

  it('places an inline discussion with the MR diff refs', async () => {
    const { processor, gitlab } = setup(
      commentRow(
        { kind: CommentKind.INLINE, path: 'a.ts', line: 9, side: DiffSide.NEW },
        GITLAB,
      ),
    );
    await processor.process(job());
    expect(gitlab.createDiscussion).toHaveBeenCalledWith(
      'https://gitlab.com',
      'token',
      '42',
      '12',
      body,
      {
        base_sha: 'b',
        start_sha: 's',
        head_sha: 'h',
        position_type: 'text',
        old_path: 'a.ts',
        new_path: 'a.ts',
        new_line: 9,
      },
    );
  });

  it('replies inside the discussion', async () => {
    const { processor, gitlab } = setup(
      commentRow(
        { parent: { body: 'x', providerThreadId: 'gitlab-discussion:d1' } },
        GITLAB,
      ),
    );
    await processor.process(job());
    expect(gitlab.addDiscussionNote).toHaveBeenCalledWith(
      'https://gitlab.com',
      'token',
      '42',
      '12',
      'd1',
      body,
    );
  });

  it('does not call GitLab with an expired token', async () => {
    const { processor, prisma, gitlab } = setup(
      commentRow({}, { ...GITLAB, state: IntegrationState.TOKEN_EXPIRED }),
    );
    await processor.process(job());
    expect(gitlab.createDiscussion).not.toHaveBeenCalled();
    expect(lastUpdate(prisma)).toMatchObject({
      syncStatus: CommentSyncStatus.FAILED,
      syncError: 'insufficient_permission',
    });
  });
});
