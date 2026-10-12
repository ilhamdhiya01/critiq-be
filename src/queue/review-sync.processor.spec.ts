import type { Job } from 'bullmq';
import { Logger } from 'winston';
import { EncryptionService } from '../common/encryption/encryption.service';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  IntegrationState,
  Provider,
  ReviewDecision,
  ReviewSyncStatus,
} from '../generated/prisma/enums';
import { GithubAppService } from '../modules/integrations/github-app.service';
import { GitlabApiService } from '../modules/integrations/gitlab-api.service';
import { ProviderReviewError } from '../modules/integrations/provider-review-error';
import type { ReviewSyncJobPayload } from './review-sync-queue.constants';
import { ReviewSyncProcessor } from './review-sync.processor';

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
  installationId: '169478542',
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

function reviewRow(
  overrides: Record<string, unknown> = {},
  integration = GITHUB,
) {
  return {
    id: 'rev_1',
    organizationId: 'org_1',
    pullId: 'pull_1',
    headSha: 'abc123',
    decision: ReviewDecision.APPROVE,
    body: null,
    syncStatus: ReviewSyncStatus.PENDING,
    reviewer: { name: 'Ilham', email: 'i@x.io' },
    pullRequest: {
      externalId: '1796',
      repository: { path: 'acme/web', externalId: '42', integration },
    },
    ...overrides,
  };
}

function setup(row: unknown = reviewRow()) {
  const prisma = {
    pullReview: {
      findUnique: jest.fn().mockResolvedValue(row),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const github = { submitPullReview: jest.fn().mockResolvedValue(undefined) };
  const gitlab = {
    approveMergeRequest: jest.fn().mockResolvedValue(undefined),
    unapproveMergeRequest: jest.fn().mockResolvedValue(undefined),
    createMergeRequestNote: jest.fn().mockResolvedValue(undefined),
  };
  const logger = { info: jest.fn(), warn: jest.fn() };
  const processor = new ReviewSyncProcessor(
    prisma as unknown as PrismaService,
    { decrypt: () => 'token' } as unknown as EncryptionService,
    github as unknown as GithubAppService,
    gitlab as unknown as GitlabApiService,
    logger as unknown as Logger,
  );
  return { processor, prisma, github, gitlab };
}

const job = (attemptsMade = 0) =>
  ({
    data: { reviewId: 'rev_1' },
    attemptsMade,
    opts: { attempts: 4 },
  }) as unknown as Job<ReviewSyncJobPayload>;

function statusWritten(prisma: ReturnType<typeof setup>['prisma']) {
  const [args] = prisma.pullReview.updateMany.mock.calls.at(-1) as [
    { data: { syncStatus: ReviewSyncStatus; syncError?: string | null } },
  ];
  return args.data;
}

describe('ReviewSyncProcessor', () => {
  it('approves on GitHub as the App, pinned to the reviewed commit', async () => {
    const { processor, prisma, github } = setup();
    await processor.process(job());
    expect(github.submitPullReview).toHaveBeenCalledWith(
      '169478542',
      'acme',
      'web',
      '1796',
      {
        commitId: 'abc123',
        event: 'APPROVE',
        body: 'Approved by Ilham via Critiq.',
      },
    );
    expect(statusWritten(prisma)).toMatchObject({
      syncStatus: ReviewSyncStatus.SYNCED,
      syncError: null,
    });
  });

  it('requests changes on GitHub with the reason', async () => {
    const { processor, github } = setup(
      reviewRow({
        decision: ReviewDecision.REQUEST_CHANGES,
        body: 'Missing tests',
      }),
    );
    await processor.process(job());
    expect(github.submitPullReview).toHaveBeenCalledWith(
      expect.anything(),
      'acme',
      'web',
      '1796',
      expect.objectContaining({
        event: 'REQUEST_CHANGES',
        body: 'Changes requested by Ilham via Critiq:\n\nMissing tests',
      }),
    );
  });

  it('approves on GitLab with the sha, then names the reviewer', async () => {
    const { processor, gitlab } = setup(reviewRow({}, GITLAB));
    await processor.process(job());
    expect(gitlab.approveMergeRequest).toHaveBeenCalledWith(
      'https://gitlab.com',
      'token',
      '42',
      '1796',
      'abc123',
    );
    expect(gitlab.createMergeRequestNote).toHaveBeenCalledWith(
      'https://gitlab.com',
      'token',
      '42',
      '1796',
      'Approved by Ilham via Critiq.',
    );
  });

  // The approval is what counts; a lost note must not fail it.
  it('keeps a GitLab approval whose note failed', async () => {
    const { processor, prisma, gitlab } = setup(reviewRow({}, GITLAB));
    gitlab.createMergeRequestNote.mockRejectedValue(new Error('boom'));
    await processor.process(job());
    expect(statusWritten(prisma).syncStatus).toBe(ReviewSyncStatus.SYNCED);
  });

  it('requests changes on GitLab by unapproving with a note', async () => {
    const { processor, gitlab } = setup(
      reviewRow(
        { decision: ReviewDecision.REQUEST_CHANGES, body: 'Missing tests' },
        GITLAB,
      ),
    );
    await processor.process(job());
    expect(gitlab.unapproveMergeRequest).toHaveBeenCalled();
    expect(gitlab.approveMergeRequest).not.toHaveBeenCalled();
    expect(gitlab.createMergeRequestNote).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      '42',
      '1796',
      'Changes requested by Ilham via Critiq:\n\nMissing tests',
    );
  });

  it('fails at once when the provider refuses', async () => {
    const { processor, prisma, github } = setup();
    github.submitPullReview.mockRejectedValue(
      new ProviderReviewError('insufficient_permission', false),
    );
    await expect(processor.process(job())).resolves.toBeUndefined();
    expect(statusWritten(prisma)).toEqual({
      syncStatus: ReviewSyncStatus.FAILED,
      syncError: 'insufficient_permission',
    });
  });

  it('leaves a transient failure to BullMQ to retry', async () => {
    const { processor, prisma, github } = setup();
    const unreachable = new ProviderReviewError('provider_unreachable', true);
    github.submitPullReview.mockRejectedValue(unreachable);
    await expect(processor.process(job(0))).rejects.toBe(unreachable);
    expect(prisma.pullReview.updateMany).not.toHaveBeenCalled();
  });

  it('fails a transient failure on the last attempt', async () => {
    const { processor, prisma, github } = setup();
    github.submitPullReview.mockRejectedValue(
      new ProviderReviewError('provider_unreachable', true),
    );
    await processor.process(job(3));
    expect(statusWritten(prisma)).toEqual({
      syncStatus: ReviewSyncStatus.FAILED,
      syncError: 'provider_unreachable',
    });
  });

  it.each([
    IntegrationState.UNINSTALLED,
    IntegrationState.SUSPENDED,
    IntegrationState.TOKEN_EXPIRED,
  ])('does not call the provider with an integration %s', async (state) => {
    const { processor, prisma, github } = setup(
      reviewRow({}, { ...GITHUB, state }),
    );
    await processor.process(job());
    expect(github.submitPullReview).not.toHaveBeenCalled();
    expect(statusWritten(prisma)).toMatchObject({
      syncStatus: ReviewSyncStatus.FAILED,
      syncError: 'insufficient_permission',
    });
  });

  it('skips a copy that is no longer pending', async () => {
    const { processor, prisma, github } = setup(
      reviewRow({ syncStatus: ReviewSyncStatus.SYNCED }),
    );
    await processor.process(job());
    expect(github.submitPullReview).not.toHaveBeenCalled();
    expect(prisma.pullReview.updateMany).not.toHaveBeenCalled();
  });
});
