import type Redis from 'ioredis';
import { Logger } from 'winston';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimePublisher, toWire } from './realtime.publisher';

jest.mock('../prisma/prisma.service', () => ({ PrismaService: class {} }));

function setup() {
  const redis = { publish: jest.fn().mockResolvedValue(1) };
  const prisma = {
    scan: { findUnique: jest.fn() },
    pullReview: { findUnique: jest.fn() },
    pullComment: { findUnique: jest.fn() },
  };
  const logger = { warn: jest.fn() };
  const publisher = new RealtimePublisher(
    redis as unknown as Redis,
    prisma as unknown as PrismaService,
    logger as unknown as Logger,
  );
  return { publisher, redis, prisma, logger };
}

const published = (redis: ReturnType<typeof setup>['redis']) => {
  const [channel, message] = redis.publish.mock.calls[0] as [string, string];
  return { channel, event: JSON.parse(message) as Record<string, unknown> };
};

describe('toWire', () => {
  // The same spelling as REST: lowercase enum values.
  it('lowercases enum values and stamps id and time', () => {
    expect(
      toWire(
        {
          type: 'scan.updated',
          orgId: 'org_1',
          repoId: 'repo_1',
          pullId: 'pull_1',
          scanId: 'scan_1',
          status: 'RUNNING',
          aiStatus: null,
        },
        'evt_1',
        new Date('2026-10-13T00:00:00Z'),
      ),
    ).toEqual({
      id: 'evt_1',
      at: '2026-10-13T00:00:00.000Z',
      type: 'scan.updated',
      orgId: 'org_1',
      repoId: 'repo_1',
      pullId: 'pull_1',
      scanId: 'scan_1',
      status: 'running',
      aiStatus: null,
    });
  });

  it('keeps non-enum fields as they are', () => {
    expect(
      toWire({
        type: 'pull.updated',
        orgId: 'org_1',
        repoId: 'repo_1',
        pullId: 'pull_1',
        state: 'MERGED',
        headChanged: true,
      }),
    ).toMatchObject({ state: 'merged', headChanged: true });
  });
});

describe('RealtimePublisher', () => {
  it("publishes to the organization's channel", async () => {
    const { publisher, redis } = setup();
    await publisher.publish({
      type: 'settings.updated',
      orgId: 'org_1',
      area: 'rules',
    });
    const { channel, event } = published(redis);
    expect(channel).toBe('critiq:events:org:org_1');
    expect(event).toMatchObject({ type: 'settings.updated', area: 'rules' });
  });

  // A lost event is covered by the client's polling; a webhook or a scan
  // failing because of it would not be.
  it('never throws when Redis fails', async () => {
    const { publisher, redis, logger } = setup();
    redis.publish.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(
      publisher.publish({
        type: 'settings.updated',
        orgId: 'org_1',
        area: 'ai',
      }),
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      'realtime.publish_failed',
      expect.objectContaining({ orgId: 'org_1', type: 'settings.updated' }),
    );
  });

  it('publishes the scan as it is in the database', async () => {
    const { publisher, redis, prisma } = setup();
    prisma.scan.findUnique.mockResolvedValue({
      organizationId: 'org_1',
      repositoryId: 'repo_1',
      pullId: 'pull_1',
      status: 'DONE',
      aiStatus: 'QUEUED',
    });
    await publisher.scanChanged('scan_1');
    expect(published(redis).event).toMatchObject({
      type: 'scan.updated',
      orgId: 'org_1',
      repoId: 'repo_1',
      pullId: 'pull_1',
      scanId: 'scan_1',
      status: 'done',
      aiStatus: 'queued',
    });
  });

  it('publishes nothing for a scan that is gone', async () => {
    const { publisher, redis, prisma } = setup();
    prisma.scan.findUnique.mockResolvedValue(null);
    await publisher.scanChanged('scan_1');
    expect(redis.publish).not.toHaveBeenCalled();
  });

  it('never throws when the lookup fails', async () => {
    const { publisher, redis, prisma } = setup();
    prisma.pullReview.findUnique.mockRejectedValue(new Error('db down'));
    await expect(publisher.reviewChanged('rev_1')).resolves.toBeUndefined();
    expect(redis.publish).not.toHaveBeenCalled();
  });

  it('publishes a comment change with its PR', async () => {
    const { publisher, redis, prisma } = setup();
    prisma.pullComment.findUnique.mockResolvedValue({
      organizationId: 'org_1',
      pullId: 'pull_1',
      pullRequest: { repositoryId: 'repo_1' },
    });
    await publisher.commentChanged('c1', 'synced');
    expect(published(redis).event).toMatchObject({
      type: 'comment.updated',
      repoId: 'repo_1',
      pullId: 'pull_1',
      commentId: 'c1',
      change: 'synced',
    });
  });
});
