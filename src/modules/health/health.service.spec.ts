import { HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import type Redis from 'ioredis';
import type { Response } from 'express';
import { PrismaService } from '../../common/prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

// ESM-only packages reachable through the imports; every collaborator is a
// plain stub below.
jest.mock('@nestjs/config', () => ({ ConfigService: class {} }));
jest.mock('@nestjs/bullmq', () => ({ InjectQueue: () => () => undefined }));
jest.mock('bullmq', () => ({ Queue: class {} }));
jest.mock('../../common/prisma/prisma.service', () => ({
  PrismaService: class {},
}));
// Exports the scan queue name but loads the generated Prisma client.
jest.mock('../../queue/scan-queue.service', () => ({
  SCAN_QUEUE_NAME: 'scan',
}));
jest.mock('../settings/settings.service', () => ({
  SettingsService: class {},
}));

const COUNTS = { waiting: 2, active: 1, delayed: 0, failed: 3 };

function setup() {
  const prisma = {
    $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
  };
  const redis = {
    ping: jest.fn().mockResolvedValue('PONG'),
    scan: jest
      .fn()
      .mockResolvedValue([
        '0',
        ['worker:heartbeat:host-a:1', 'worker:heartbeat:host-b:2'],
      ]),
    mget: jest
      .fn()
      .mockResolvedValue([
        '2026-10-12T04:00:00.000Z',
        '2026-10-12T04:00:05.000Z',
      ]),
  };
  const queue = { getJobCounts: jest.fn().mockResolvedValue(COUNTS) };
  const settings = { countConfiguredOrgs: jest.fn().mockResolvedValue(4) };
  const service = new HealthService(
    prisma as unknown as PrismaService,
    redis as unknown as Redis,
    queue as unknown as Queue,
    queue as unknown as Queue,
    settings as unknown as SettingsService,
  );
  return { service, prisma, redis, queue, settings };
}

describe('HealthService', () => {
  it('is ok with the database, Redis and a live worker', async () => {
    const { service } = setup();
    await expect(service.check(false)).resolves.toEqual({
      status: 'ok',
      checks: { db: 'ok', redis: 'ok', worker: 'ok' },
      details: undefined,
    });
  });

  // The app still answers; scans and AI reviews wait for a worker.
  it('is degraded without a live worker', async () => {
    const { service, redis } = setup();
    redis.scan.mockResolvedValue(['0', []]);
    await expect(service.check(false)).resolves.toMatchObject({
      status: 'degraded',
      checks: { worker: 'fail' },
    });
  });

  it('is down when the database fails', async () => {
    const { service, prisma } = setup();
    prisma.$queryRaw.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(service.check(false)).resolves.toMatchObject({
      status: 'down',
      checks: { db: 'fail', redis: 'ok' },
    });
  });

  it('is down when Redis fails, without asking it for workers', async () => {
    const { service, redis } = setup();
    redis.ping.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(service.check(false)).resolves.toMatchObject({
      status: 'down',
      checks: { redis: 'fail', worker: 'fail' },
    });
    expect(redis.scan).not.toHaveBeenCalled();
  });

  // A hung dependency must not hang /health with it.
  it('fails a check that does not answer in time', async () => {
    jest.useFakeTimers();
    try {
      const { service, prisma } = setup();
      prisma.$queryRaw.mockReturnValue(new Promise(() => undefined));
      const result = service.check(false);
      await jest.advanceTimersByTimeAsync(2000);
      await expect(result).resolves.toMatchObject({
        status: 'down',
        checks: { db: 'fail' },
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('adds queue counts, workers and AI orgs on request', async () => {
    const { service } = setup();
    await expect(service.check(true)).resolves.toMatchObject({
      details: {
        queues: { scan: COUNTS, ai: COUNTS },
        workers: { alive: 2, lastBeatAt: '2026-10-12T04:00:05.000Z' },
        ai: { configuredOrgs: 4 },
      },
    });
  });

  it('reports a detail it cannot read as null', async () => {
    const { service, queue } = setup();
    queue.getJobCounts.mockRejectedValue(new Error('boom'));
    const health = await service.check(true);
    expect(health.status).toBe('ok');
    expect(health.details?.queues).toEqual({ scan: null, ai: null });
  });
});

describe('HealthController', () => {
  function controllerWith(token: string) {
    const { service } = setup();
    const check = jest.spyOn(service, 'check');
    const config = { get: () => token };
    const controller = new HealthController(
      service,
      config as unknown as ConfigService,
    );
    const res = { status: jest.fn() };
    return { controller, check, res };
  }

  it.each([
    ['the right token', 'Bearer s3cret', true],
    ['a wrong token', 'Bearer nope', false],
    ['no token', undefined, false],
    ['a non-bearer header', 's3cret', false],
  ])('gives details only for %s', async (_label, header, details) => {
    const { controller, check, res } = controllerWith('s3cret');
    await controller.check(header, res as unknown as Response);
    expect(check).toHaveBeenCalledWith(details);
  });

  // An unset HEALTH_TOKEN must not turn "Bearer " into a match.
  it('never gives details when no token is configured', async () => {
    const { controller, check, res } = controllerWith('');
    await controller.check('Bearer ', res as unknown as Response);
    expect(check).toHaveBeenCalledWith(false);
  });

  it('answers 503 only when down', async () => {
    const { controller, check, res } = controllerWith('');
    check.mockResolvedValueOnce({
      status: 'down',
      checks: { db: 'fail', redis: 'ok', worker: 'ok' },
    });
    await controller.check(undefined, res as unknown as Response);
    expect(res.status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);

    check.mockResolvedValueOnce({
      status: 'degraded',
      checks: { db: 'ok', redis: 'ok', worker: 'fail' },
    });
    res.status.mockClear();
    await controller.check(undefined, res as unknown as Response);
    expect(res.status).not.toHaveBeenCalled();
  });
});
