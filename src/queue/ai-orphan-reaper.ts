import { InjectQueue } from '@nestjs/bullmq';
import {
  Inject,
  Injectable,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { JobType, Queue } from 'bullmq';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import { Logger } from 'winston';
import { PrismaService } from '../common/prisma/prisma.service';
import { RealtimePublisher } from '../common/realtime/realtime.publisher';
import { AiScanStatus } from '../generated/prisma/enums';
import { AI_QUEUE_NAME, AiJobPayload } from './ai-queue.constants';

export const REAP_INTERVAL_MS = 5 * 60_000;
// Covers the gap between AiScanService.maybeEnqueue writing QUEUED and its
// queue.add landing, so a job about to appear is not taken for lost.
export const REAP_GRACE_MS = 2 * 60_000;
const REAP_BATCH = 200;
export const WORKER_LOST = 'worker_lost';

const IN_FLIGHT: AiScanStatus[] = [AiScanStatus.QUEUED, AiScanStatus.RUNNING];
// Every state in which a job may still run (a paused queue keeps its jobs
// in `waiting`).
const LIVE_JOB_STATES: JobType[] = [
  'active',
  'waiting',
  'delayed',
  'prioritized',
  'waiting-children',
];

export interface InFlightScan {
  id: string;
  organizationId: string;
  aiStatus: AiScanStatus | null;
  aiStartedAt: Date | null;
  // When the static scan finished: a QUEUED review has no time of its own.
  finishedAt: Date | null;
}

// Scans whose AI review the database calls in flight while no job for it
// lives in the queue — the job ran somewhere else, or its worker died
// before recording the outcome.
export function findOrphans(
  scans: InFlightScan[],
  liveScanIds: ReadonlySet<string>,
  now: Date,
): InFlightScan[] {
  return scans.filter((scan) => {
    if (liveScanIds.has(scan.id)) {
      return false;
    }
    const since = scan.aiStartedAt ?? scan.finishedAt;
    return since !== null && now.getTime() - since.getTime() > REAP_GRACE_MS;
  });
}

// Worker only (WorkerModule): the same queue and Redis as AiScanProcessor.
// Without it an AI status left QUEUED/RUNNING with no job behind it shows
// "AI reviewing" forever and keeps rescan and regenerate refused
// (rescanBlocker) — PR #27 critiq-fe, 22 Oct 2026. Every organization is
// swept: system maintenance, nothing is returned to any user.
@Injectable()
export class AiOrphanReaper implements OnApplicationBootstrap, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(AI_QUEUE_NAME) private readonly aiQueue: Queue<AiJobPayload>,
    private readonly realtime: RealtimePublisher,
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.reap(), REAP_INTERVAL_MS);
    void this.reap();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // Never throws: a failed sweep is retried by the next one.
  async reap(now: Date = new Date()): Promise<number> {
    try {
      const scans = await this.prisma.scan.findMany({
        where: { aiStatus: { in: IN_FLIGHT } },
        select: {
          id: true,
          organizationId: true,
          aiStatus: true,
          aiStartedAt: true,
          finishedAt: true,
        },
        take: REAP_BATCH,
      });
      if (scans.length === 0) {
        return 0;
      }
      const jobs = await this.aiQueue.getJobs(LIVE_JOB_STATES);
      const live = new Set(jobs.map((job) => job?.data.scanId));

      let reaped = 0;
      for (const scan of findOrphans(scans, live, now)) {
        const { count } = await this.prisma.scan.updateMany({
          where: { id: scan.id, aiStatus: { in: IN_FLIGHT } },
          data: {
            aiStatus: AiScanStatus.FAILED,
            aiErrorCode: WORKER_LOST,
            aiFinishedAt: now,
          },
        });
        if (count === 0) {
          continue;
        }
        reaped += 1;
        this.logger.warn('ai.orphan_reaped', {
          orgId: scan.organizationId,
          scanId: scan.id,
          previousStatus: scan.aiStatus,
        });
        await this.realtime.scanChanged(scan.id);
      }
      return reaped;
    } catch (error) {
      this.logger.error('ai.reaper_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    }
  }
}
