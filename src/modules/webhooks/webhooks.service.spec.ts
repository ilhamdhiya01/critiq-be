import { createHmac } from 'crypto';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { Logger } from 'winston';
import { EncryptionService } from '../../common/encryption/encryption.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  Provider,
  PullRequestState,
  ScanStatus,
  ScanTrigger,
} from '../../generated/prisma/enums';
import { ScanQueueService } from '../../queue/scan-queue.service';
import { PullsService } from '../pulls/pulls.service';
import { WebhooksService } from './webhooks.service';

// @nestjs/config v12 — and the provider SDKs reachable through
// PullsService/ScanQueueService (@nestjs/bullmq, @nestjs/axios, @octokit/*)
// — ship ESM-only builds this CommonJS Jest setup cannot load. Every
// collaborator is replaced by a plain stub below anyway, so their modules
// are mocked out wholesale rather than transforming node_modules.
jest.mock('@nestjs/config', () => ({ ConfigService: class {} }));
jest.mock('../../common/prisma/prisma.service', () => ({
  PrismaService: class {},
}));
jest.mock('../../common/encryption/encryption.service', () => ({
  EncryptionService: class {},
}));
jest.mock('../../queue/scan-queue.service', () => ({
  ScanQueueService: class {},
}));
jest.mock('../pulls/pulls.service', () => ({ PullsService: class {} }));

const GITHUB_SECRET = 'github-app-webhook-secret';
const GITLAB_SECRET = 'per-repo-gitlab-secret';

const repository = {
  id: 'repo_1',
  organizationId: 'org_1',
  encryptedWebhookSecret: 'encrypted',
  scanConfig: { branches: ['main'] },
};

function setup() {
  const prisma = { repository: { findFirst: jest.fn() } };
  const encryptionService = { decrypt: jest.fn(() => GITLAB_SECRET) };
  const configService = { getOrThrow: jest.fn(() => GITHUB_SECRET) };
  const pullsService = {
    upsertFromWebhook: jest.fn().mockResolvedValue({
      id: 'pull_1',
      state: PullRequestState.OPEN,
      headSha: 'abc123',
    }),
  };
  const scanQueueService = {
    enqueue: jest.fn().mockResolvedValue({
      scanId: 'scan_1',
      status: ScanStatus.QUEUED,
      deduplicated: false,
    }),
    cancelPending: jest.fn().mockResolvedValue(1),
  };
  const redis = {
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
  };
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

  prisma.repository.findFirst.mockResolvedValue(repository);

  const service = new WebhooksService(
    prisma as unknown as PrismaService,
    encryptionService as unknown as EncryptionService,
    configService as unknown as ConfigService,
    pullsService as unknown as PullsService,
    scanQueueService as unknown as ScanQueueService,
    redis as unknown as Redis,
    logger as unknown as Logger,
  );
  return { service, prisma, pullsService, scanQueueService, redis };
}

function githubPayload(overrides: { action?: string; baseRef?: string } = {}) {
  return {
    action: overrides.action ?? 'opened',
    repository: { id: 42 },
    pull_request: {
      number: 7,
      title: 'Add feature',
      state: overrides.action === 'closed' ? 'closed' : 'open',
      merged: false,
      head: { sha: 'abc123', ref: 'feature' },
      base: { ref: overrides.baseRef ?? 'main', sha: 'base999' },
    },
  };
}

function signedGithub(body: object, extraHeaders: Record<string, string> = {}) {
  const rawBody = Buffer.from(JSON.stringify(body));
  const signature =
    'sha256=' +
    createHmac('sha256', GITHUB_SECRET).update(rawBody).digest('hex');
  return {
    rawBody,
    headers: {
      'x-hub-signature-256': signature,
      'x-github-event': 'pull_request',
      'x-github-delivery': 'delivery-1',
      ...extraHeaders,
    },
  };
}

function gitlabPayload(action: string, oldrev?: string) {
  return {
    object_kind: 'merge_request',
    project: { id: 99 },
    object_attributes: {
      iid: 3,
      title: 'MR',
      state: 'opened',
      target_branch: 'main',
      source_branch: 'feature',
      last_commit: { id: 'abc123' },
      action,
      ...(oldrev ? { oldrev } : {}),
    },
  };
}

function gitlabRequest(body: object, token = GITLAB_SECRET) {
  return {
    rawBody: Buffer.from(JSON.stringify(body)),
    headers: { 'x-gitlab-token': token, 'x-gitlab-event-uuid': 'uuid-1' },
  };
}

describe('WebhooksService — GitHub', () => {
  it('rejects a bad signature before touching the database', async () => {
    const { service, prisma, redis } = setup();
    const { rawBody, headers } = signedGithub(githubPayload());

    const outcome = await service.handleGithubEvent(rawBody, {
      ...headers,
      'x-hub-signature-256': 'sha256=forged',
    });

    expect(outcome).toEqual({ kind: 'rejected' });
    expect(prisma.repository.findFirst).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('acknowledges ping events', async () => {
    const { service } = setup();
    const { rawBody, headers } = signedGithub({ zen: 'Keep it simple.' });

    const outcome = await service.handleGithubEvent(rawBody, headers);

    expect(outcome).toEqual({ kind: 'skipped', reason: 'ping' });
  });

  it('ignores non-pull_request events that also carry a pull_request object', async () => {
    const { service, pullsService } = setup();
    const { rawBody, headers } = signedGithub(githubPayload(), {
      'x-github-event': 'pull_request_review',
    });

    const outcome = await service.handleGithubEvent(rawBody, headers);

    expect(outcome).toEqual({ kind: 'skipped', reason: 'unsupported_event' });
    expect(pullsService.upsertFromWebhook).not.toHaveBeenCalled();
  });

  it('skips (200) a repo installed on GitHub but never connected to Critiq', async () => {
    const { service, prisma } = setup();
    prisma.repository.findFirst.mockResolvedValue(null);
    const { rawBody, headers } = signedGithub(githubPayload());

    const outcome = await service.handleGithubEvent(rawBody, headers);

    expect(outcome).toEqual({ kind: 'skipped', reason: 'unknown_repo' });
  });

  it('enqueues a webhook scan for an opened PR in scope', async () => {
    const { service, scanQueueService, redis } = setup();
    const { rawBody, headers } = signedGithub(githubPayload());

    const outcome = await service.handleGithubEvent(rawBody, headers);

    expect(outcome).toEqual({
      kind: 'scan_enqueued',
      scanId: 'scan_1',
      deduplicated: false,
    });
    expect(redis.set).toHaveBeenCalledWith(
      'webhook:delivery:GITHUB:delivery-1',
      '1',
      'EX',
      86_400,
      'NX',
    );
    expect(scanQueueService.enqueue).toHaveBeenCalledWith({
      organizationId: 'org_1',
      repositoryId: 'repo_1',
      pullId: 'pull_1',
      headSha: 'abc123',
      baseSha: 'base999',
      provider: Provider.GITHUB,
      trigger: ScanTrigger.WEBHOOK,
    });
  });

  it('treats an already-seen delivery id as a duplicate with no side effects', async () => {
    const { service, redis, pullsService, scanQueueService } = setup();
    redis.set.mockResolvedValue(null);
    const { rawBody, headers } = signedGithub(githubPayload());

    const outcome = await service.handleGithubEvent(rawBody, headers);

    expect(outcome).toEqual({ kind: 'duplicate' });
    expect(pullsService.upsertFromWebhook).not.toHaveBeenCalled();
    expect(scanQueueService.enqueue).not.toHaveBeenCalled();
  });

  it('still processes the event when Redis is unavailable (fail open)', async () => {
    const { service, redis, scanQueueService } = setup();
    redis.set.mockRejectedValue(new Error('ECONNREFUSED'));
    const { rawBody, headers } = signedGithub(githubPayload());

    const outcome = await service.handleGithubEvent(rawBody, headers);

    expect(outcome.kind).toBe('scan_enqueued');
    expect(scanQueueService.enqueue).toHaveBeenCalled();
  });

  it('skips a PR targeting a branch outside the scan scope', async () => {
    const { service, pullsService } = setup();
    const { rawBody, headers } = signedGithub(
      githubPayload({ baseRef: 'develop' }),
    );

    const outcome = await service.handleGithubEvent(rawBody, headers);

    expect(outcome).toEqual({ kind: 'skipped', reason: 'out_of_scope' });
    expect(pullsService.upsertFromWebhook).not.toHaveBeenCalled();
  });

  it('cancels pending scans instead of enqueueing when the PR is closed', async () => {
    const { service, pullsService, scanQueueService } = setup();
    pullsService.upsertFromWebhook.mockResolvedValue({
      id: 'pull_1',
      state: PullRequestState.CLOSED,
      headSha: 'abc123',
    });
    const { rawBody, headers } = signedGithub(
      githubPayload({ action: 'closed' }),
    );

    const outcome = await service.handleGithubEvent(rawBody, headers);

    expect(outcome).toEqual({ kind: 'pull_closed' });
    expect(scanQueueService.cancelPending).toHaveBeenCalledWith('pull_1');
    expect(scanQueueService.enqueue).not.toHaveBeenCalled();
  });

  it('upserts but does not scan on metadata-only actions', async () => {
    const { service, pullsService, scanQueueService } = setup();
    const { rawBody, headers } = signedGithub(
      githubPayload({ action: 'labeled' }),
    );

    const outcome = await service.handleGithubEvent(rawBody, headers);

    expect(outcome).toEqual({ kind: 'skipped', reason: 'not_scan_trigger' });
    expect(pullsService.upsertFromWebhook).toHaveBeenCalled();
    expect(scanQueueService.enqueue).not.toHaveBeenCalled();
  });

  it('releases the delivery claim when processing fails, so a redelivery can retry', async () => {
    const { service, scanQueueService, redis } = setup();
    scanQueueService.enqueue.mockRejectedValue(new Error('db down'));
    const { rawBody, headers } = signedGithub(githubPayload());

    await expect(service.handleGithubEvent(rawBody, headers)).rejects.toThrow(
      'db down',
    );
    expect(redis.del).toHaveBeenCalledWith(
      'webhook:delivery:GITHUB:delivery-1',
    );
  });
});

describe('WebhooksService — GitLab', () => {
  it('rejects a delivery for an unknown project as unauthenticated', async () => {
    const { service, prisma } = setup();
    prisma.repository.findFirst.mockResolvedValue(null);
    const { rawBody, headers } = gitlabRequest(gitlabPayload('open'));

    const outcome = await service.handleGitlabEvent(rawBody, headers);

    expect(outcome).toEqual({ kind: 'rejected' });
  });

  it('rejects a wrong X-Gitlab-Token', async () => {
    const { service, pullsService } = setup();
    const { rawBody, headers } = gitlabRequest(
      gitlabPayload('open'),
      'wrong-token',
    );

    const outcome = await service.handleGitlabEvent(rawBody, headers);

    expect(outcome).toEqual({ kind: 'rejected' });
    expect(pullsService.upsertFromWebhook).not.toHaveBeenCalled();
  });

  it('does not scan an `update` without new commits (no oldrev)', async () => {
    const { service, scanQueueService } = setup();
    const { rawBody, headers } = gitlabRequest(gitlabPayload('update'));

    const outcome = await service.handleGitlabEvent(rawBody, headers);

    expect(outcome).toEqual({ kind: 'skipped', reason: 'not_scan_trigger' });
    expect(scanQueueService.enqueue).not.toHaveBeenCalled();
  });

  it('scans an `update` that pushed new commits, with a null baseSha', async () => {
    const { service, scanQueueService } = setup();
    const { rawBody, headers } = gitlabRequest(
      gitlabPayload('update', 'previous-head-sha'),
    );

    const outcome = await service.handleGitlabEvent(rawBody, headers);

    expect(outcome.kind).toBe('scan_enqueued');
    expect(scanQueueService.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: Provider.GITLAB,
        baseSha: null,
        trigger: ScanTrigger.WEBHOOK,
      }),
    );
  });
});
