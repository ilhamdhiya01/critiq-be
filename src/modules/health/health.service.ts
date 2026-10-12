import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import type Redis from 'ioredis';
import { PrismaService } from '../../common/prisma/prisma.service';
import { REDIS_CLIENT } from '../../common/redis/redis.constants';
import { WORKER_HEARTBEAT_PREFIX } from '../../common/redis/worker-heartbeat';
import { AI_QUEUE_NAME } from '../../queue/ai-queue.constants';
import { SCAN_QUEUE_NAME } from '../../queue/scan-queue.service';
import { SettingsService } from '../settings/settings.service';
import {
  HealthCheckState,
  HealthDetailsDto,
  HealthDto,
  QueueCountsDto,
} from './dto/health.dto';

// Every check is bounded: a hung database or Redis must make /health
// answer `down`, not hang with it.
const CHECK_TIMEOUT_MS = 2000;
const QUEUE_COUNT_STATES = ['waiting', 'active', 'delayed', 'failed'] as const;

function withTimeout<T>(
  promise: Promise<T>,
  ms = CHECK_TIMEOUT_MS,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

// Settled to a value or null — one failing check never fails the others.
async function attempt<T>(run: () => Promise<T>): Promise<T | null> {
  try {
    return await withTimeout(run());
  } catch {
    return null;
  }
}

interface WorkerBeats {
  alive: number;
  lastBeatAt: string | null;
}

@Injectable()
export class HealthService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @InjectQueue(SCAN_QUEUE_NAME) private readonly scanQueue: Queue,
    @InjectQueue(AI_QUEUE_NAME) private readonly aiQueue: Queue,
    private readonly settingsService: SettingsService,
  ) {}

  // down: the database or Redis is unreachable — nothing works. degraded:
  // no worker is alive — the app answers, but scans and AI reviews wait.
  async check(withDetails: boolean): Promise<HealthDto> {
    const [db, redis] = await Promise.all([
      attempt(() => this.prisma.$queryRaw`SELECT 1`),
      attempt(() => this.redis.ping()),
    ]);
    const dbState: HealthCheckState = db !== null ? 'ok' : 'fail';
    const redisState: HealthCheckState = redis === 'PONG' ? 'ok' : 'fail';
    const workers =
      redisState === 'ok' ? await attempt(() => this.workerBeats()) : null;
    const workerState: HealthCheckState =
      workers !== null && workers.alive > 0 ? 'ok' : 'fail';

    const status =
      dbState === 'fail' || redisState === 'fail'
        ? 'down'
        : workerState === 'fail'
          ? 'degraded'
          : 'ok';

    return new HealthDto({
      status,
      checks: { db: dbState, redis: redisState, worker: workerState },
      details: withDetails
        ? await this.details(dbState === 'ok', redisState === 'ok', workers)
        : undefined,
    });
  }

  // Cross-organization numbers: only for a caller holding HEALTH_TOKEN.
  private async details(
    dbUp: boolean,
    redisUp: boolean,
    workers: WorkerBeats | null,
  ): Promise<HealthDetailsDto> {
    const [scan, ai, configuredOrgs] = await Promise.all([
      redisUp ? attempt(() => this.queueCounts(this.scanQueue)) : null,
      redisUp ? attempt(() => this.queueCounts(this.aiQueue)) : null,
      dbUp ? attempt(() => this.settingsService.countConfiguredOrgs()) : null,
    ]);
    return {
      queues: { scan, ai },
      workers: workers ?? { alive: 0, lastBeatAt: null },
      ai: { configuredOrgs },
    };
  }

  private async queueCounts(queue: Queue): Promise<QueueCountsDto> {
    const counts = await queue.getJobCounts(...QUEUE_COUNT_STATES);
    return {
      waiting: counts.waiting ?? 0,
      active: counts.active ?? 0,
      delayed: counts.delayed ?? 0,
      failed: counts.failed ?? 0,
    };
  }

  // A worker key expires HEARTBEAT_TTL_SECONDS after its last beat, so the
  // keys that exist are the workers alive now. SCAN, not KEYS: never blocks
  // Redis, whatever else it holds.
  private async workerBeats(): Promise<WorkerBeats> {
    const keys: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await this.redis.scan(
        cursor,
        'MATCH',
        `${WORKER_HEARTBEAT_PREFIX}*`,
        'COUNT',
        100,
      );
      cursor = next;
      keys.push(...batch);
    } while (cursor !== '0');
    if (keys.length === 0) {
      return { alive: 0, lastBeatAt: null };
    }
    const beats = (await this.redis.mget(...keys)).filter(
      (value): value is string => value !== null,
    );
    return {
      alive: beats.length,
      lastBeatAt: beats.length > 0 ? beats.sort().at(-1)! : null,
    };
  }
}
