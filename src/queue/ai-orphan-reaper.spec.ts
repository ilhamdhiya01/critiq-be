import { Queue } from 'bullmq';
import { Logger } from 'winston';
import { PrismaService } from '../common/prisma/prisma.service';
import { RealtimePublisher } from '../common/realtime/realtime.publisher';
import { AiScanStatus } from '../generated/prisma/enums';
import {
  AiOrphanReaper,
  findOrphans,
  InFlightScan,
  REAP_INTERVAL_MS,
} from './ai-orphan-reaper';
import { AiJobPayload } from './ai-queue.constants';

jest.mock('@nestjs/bullmq', () => ({ InjectQueue: () => () => undefined }));
jest.mock('bullmq', () => ({ Queue: class {} }));
jest.mock('../common/prisma/prisma.service', () => ({
  PrismaService: class {},
}));
jest.mock('../common/realtime/realtime.publisher', () => ({
  RealtimePublisher: class {},
}));

const NOW = new Date('2026-10-23T01:00:00Z');
const minutesAgo = (minutes: number) =>
  new Date(NOW.getTime() - minutes * 60_000);

const scan = (overrides: Partial<InFlightScan> = {}): InFlightScan => ({
  id: 'scan_1',
  organizationId: 'org_1',
  aiStatus: AiScanStatus.RUNNING,
  aiStartedAt: minutesAgo(30),
  finishedAt: minutesAgo(31),
  ...overrides,
});

describe('findOrphans', () => {
  it('takes a review with no live job, past the grace period', () => {
    expect(findOrphans([scan()], new Set(), NOW)).toEqual([scan()]);
  });

  it('leaves a review whose job still lives in the queue', () => {
    expect(findOrphans([scan()], new Set(['scan_1']), NOW)).toEqual([]);
  });

  // QUEUED is written just before queue.add lands.
  it('leaves a review inside the grace period', () => {
    expect(
      findOrphans([scan({ aiStartedAt: minutesAgo(1) })], new Set(), NOW),
    ).toEqual([]);
  });

  // A QUEUED review has no time of its own: the static scan's end stands in.
  it.each([
    [minutesAgo(10), true],
    [minutesAgo(1), false],
  ])(
    'times a QUEUED review from the static scan (finished %p → orphan %p)',
    (finishedAt, orphan) => {
      const queued = scan({
        aiStatus: AiScanStatus.QUEUED,
        aiStartedAt: null,
        finishedAt,
      });
      expect(findOrphans([queued], new Set(), NOW)).toHaveLength(
        orphan ? 1 : 0,
      );
    },
  );

  it('leaves a review with no time to judge it by', () => {
    expect(
      findOrphans(
        [scan({ aiStartedAt: null, finishedAt: null })],
        new Set(),
        NOW,
      ),
    ).toEqual([]);
  });
});

function setup(scans: InFlightScan[], liveScanIds: string[] = []) {
  const prisma = {
    scan: {
      findMany: jest.fn().mockResolvedValue(scans),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const queue = {
    getJobs: jest
      .fn()
      .mockResolvedValue(liveScanIds.map((scanId) => ({ data: { scanId } }))),
  };
  const realtime = { scanChanged: jest.fn().mockResolvedValue(undefined) };
  const logger = { warn: jest.fn(), error: jest.fn() };
  const reaper = new AiOrphanReaper(
    prisma as unknown as PrismaService,
    queue as unknown as Queue<AiJobPayload>,
    realtime as unknown as RealtimePublisher,
    logger as unknown as Logger,
  );
  return { reaper, prisma, queue, realtime, logger };
}

describe('AiOrphanReaper.reap', () => {
  // PR #27 critiq-fe: RUNNING in the DB, its job never in this queue.
  it('fails an orphaned review as worker_lost and tells open tabs', async () => {
    const { reaper, prisma, realtime, logger } = setup([scan()]);

    await expect(reaper.reap(NOW)).resolves.toBe(1);

    expect(prisma.scan.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'scan_1',
        aiStatus: { in: [AiScanStatus.QUEUED, AiScanStatus.RUNNING] },
      },
      data: {
        aiStatus: AiScanStatus.FAILED,
        aiErrorCode: 'worker_lost',
        aiFinishedAt: NOW,
      },
    });
    expect(realtime.scanChanged).toHaveBeenCalledWith('scan_1');
    expect(logger.warn).toHaveBeenCalledWith('ai.orphan_reaped', {
      orgId: 'org_1',
      scanId: 'scan_1',
      previousStatus: AiScanStatus.RUNNING,
    });
  });

  it('looks for live jobs in every state a job can still run from', async () => {
    const { reaper, queue } = setup([scan()]);
    await reaper.reap(NOW);
    expect(queue.getJobs).toHaveBeenCalledWith([
      'active',
      'waiting',
      'delayed',
      'prioritized',
      'waiting-children',
    ]);
  });

  it('leaves a review whose job is still queued or running', async () => {
    const { reaper, prisma, realtime } = setup([scan()], ['scan_1']);
    await expect(reaper.reap(NOW)).resolves.toBe(0);
    expect(prisma.scan.updateMany).not.toHaveBeenCalled();
    expect(realtime.scanChanged).not.toHaveBeenCalled();
  });

  // The review finished between the read and the write.
  it('announces nothing when the status already moved on', async () => {
    const { reaper, prisma, realtime } = setup([scan()]);
    prisma.scan.updateMany.mockResolvedValue({ count: 0 });
    await expect(reaper.reap(NOW)).resolves.toBe(0);
    expect(realtime.scanChanged).not.toHaveBeenCalled();
  });

  it('skips the queue when nothing is in flight', async () => {
    const { reaper, queue } = setup([]);
    await expect(reaper.reap(NOW)).resolves.toBe(0);
    expect(queue.getJobs).not.toHaveBeenCalled();
  });

  it('logs a failed sweep instead of throwing', async () => {
    const { reaper, queue, logger } = setup([scan()]);
    queue.getJobs.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(reaper.reap(NOW)).resolves.toBe(0);
    expect(logger.error).toHaveBeenCalledWith('ai.reaper_failed', {
      error: 'ECONNREFUSED',
    });
  });
});

describe('AiOrphanReaper schedule', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('sweeps at boot, every five minutes, and stops on shutdown', () => {
    const { reaper } = setup([]);
    const reap = jest.spyOn(reaper, 'reap').mockResolvedValue(0);

    reaper.onApplicationBootstrap();
    expect(reap).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(REAP_INTERVAL_MS);
    expect(reap).toHaveBeenCalledTimes(2);

    reaper.onModuleDestroy();
    jest.advanceTimersByTime(REAP_INTERVAL_MS * 3);
    expect(reap).toHaveBeenCalledTimes(2);
  });
});
