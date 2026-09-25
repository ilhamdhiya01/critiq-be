import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import { Logger } from 'winston';
import { PrismaService } from '../common/prisma/prisma.service';
import { Prisma } from '../generated/prisma/client';
import { Provider, ScanStatus, ScanTrigger } from '../generated/prisma/enums';
import { RULESET_VERSION } from './rules/rules.constants';
import { ScanJobPayload } from './scan-payload.dto';

export const SCAN_QUEUE_NAME = 'scan';

// One BullMQ job per Scan row, id derived from the row. Deliberately not
// `scan:{repoId}:{prNumber}:{headSha}` as the v1.5.0 spec sketched:
// (1) BullMQ 6 rejects custom ids containing ':' unless they split into
// exactly 3 parts, so that format throws on every add(); (2) a sha-only id
// collides with the previous job still retained in the completed set
// (removeOnComplete keeps 24h) when a rescan targets the same sha, and
// BullMQ silently drops an add() whose id already exists. Dedup is instead
// enforced by the Scan table's unique (repositoryId, pullId, headSha,
// attempt) constraint, which the jobId inherits one-to-one.
export function buildScanJobId(scanId: string): string {
  return `scan-${scanId}`;
}

export interface EnqueueScanInput {
  organizationId: string;
  repositoryId: string;
  pullId: string;
  headSha: string;
  baseSha: string | null;
  provider: Provider;
  trigger: ScanTrigger;
}

export interface EnqueueScanResult {
  scanId: string;
  status: ScanStatus;
  // True when an existing scan for the same sha was returned instead of a
  // new one being created (repeated webhook delivery / synchronize).
  deduplicated: boolean;
}

// A webhook for a sha that already has one of these is a duplicate — no
// new scan. FAILED/SUPERSEDED don't count: a new push/redelivery for that
// sha gets a fresh attempt.
const WEBHOOK_DEDUPE_STATUSES: ScanStatus[] = [
  ScanStatus.QUEUED,
  ScanStatus.RUNNING,
  ScanStatus.DONE,
];

@Injectable()
export class ScanQueueService {
  constructor(
    @InjectQueue(SCAN_QUEUE_NAME)
    private readonly scanQueue: Queue<ScanJobPayload>,
    private readonly prisma: PrismaService,
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
  ) {}

  async enqueue(input: EnqueueScanInput): Promise<EnqueueScanResult> {
    const latestForSha = await this.prisma.scan.findFirst({
      where: {
        repositoryId: input.repositoryId,
        pullId: input.pullId,
        headSha: input.headSha,
      },
      orderBy: { attempt: 'desc' },
      select: { id: true, status: true, attempt: true },
    });

    if (
      input.trigger === ScanTrigger.WEBHOOK &&
      latestForSha &&
      WEBHOOK_DEDUPE_STATUSES.includes(latestForSha.status)
    ) {
      return {
        scanId: latestForSha.id,
        status: latestForSha.status,
        deduplicated: true,
      };
    }

    await this.cancelPending(input.pullId);

    let scanId: string;
    try {
      const scan = await this.prisma.scan.create({
        data: {
          organizationId: input.organizationId,
          repositoryId: input.repositoryId,
          pullId: input.pullId,
          headSha: input.headSha,
          baseSha: input.baseSha,
          status: ScanStatus.QUEUED,
          trigger: input.trigger,
          attempt: (latestForSha?.attempt ?? 0) + 1,
          rulesetVersion: RULESET_VERSION,
        },
        select: { id: true },
      });
      scanId = scan.id;
    } catch (error) {
      // Two deliveries for the same sha racing past the dedupe check above
      // — the unique constraint lets exactly one through; the loser returns
      // the winner's scan instead of failing the webhook.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const existing = await this.prisma.scan.findFirstOrThrow({
          where: {
            repositoryId: input.repositoryId,
            pullId: input.pullId,
            headSha: input.headSha,
          },
          orderBy: { attempt: 'desc' },
          select: { id: true, status: true },
        });
        return {
          scanId: existing.id,
          status: existing.status,
          deduplicated: true,
        };
      }
      throw error;
    }

    const payload: ScanJobPayload = {
      scanId,
      organizationId: input.organizationId,
      repositoryId: input.repositoryId,
      pullId: input.pullId,
      headSha: input.headSha,
      baseSha: input.baseSha,
      provider: input.provider,
      trigger: input.trigger,
    };

    try {
      await this.scanQueue.add('scan', payload, {
        jobId: buildScanJobId(scanId),
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: { age: 86_400, count: 1000 },
        removeOnFail: { age: 7 * 86_400 },
      });
    } catch (error) {
      // Without this, a QUEUED row with no job behind it would sit forever
      // and — being QUEUED — also make every later webhook for this sha
      // dedupe onto it. Fail it visibly instead.
      await this.prisma.scan.update({
        where: { id: scanId },
        data: {
          status: ScanStatus.FAILED,
          errorMessage: 'Could not enqueue scan job (queue unavailable).',
          finishedAt: new Date(),
        },
      });
      throw error;
    }

    this.logger.info('scan.enqueued', {
      orgId: input.organizationId,
      repoId: input.repositoryId,
      pullId: input.pullId,
      scanId,
      trigger: input.trigger,
    });
    return { scanId, status: ScanStatus.QUEUED, deduplicated: false };
  }

  // Supersedes every in-flight scan for a PR: waiting/delayed jobs are
  // removed from the queue; an already-active job is left to run, but its
  // Scan row is marked SUPERSEDED now, and ScanProcessor's final
  // conditional write (status must still be RUNNING) then discards its
  // result instead of overwriting this status or PullRequest.latestScanId.
  async cancelPending(pullId: string): Promise<number> {
    const inFlight = await this.prisma.scan.findMany({
      where: {
        pullId,
        status: { in: [ScanStatus.QUEUED, ScanStatus.RUNNING] },
      },
      select: { id: true },
    });
    if (inFlight.length === 0) {
      return 0;
    }

    for (const { id } of inFlight) {
      const job = await this.scanQueue.getJob(buildScanJobId(id));
      if (!job) {
        continue;
      }
      const state = await job.getState();
      if (
        state === 'waiting' ||
        state === 'delayed' ||
        state === 'prioritized'
      ) {
        await job.remove();
      }
    }

    const { count } = await this.prisma.scan.updateMany({
      where: {
        id: { in: inFlight.map(({ id }) => id) },
        status: { in: [ScanStatus.QUEUED, ScanStatus.RUNNING] },
      },
      data: { status: ScanStatus.SUPERSEDED, finishedAt: new Date() },
    });
    this.logger.info('scan.superseded', { pullId, count });
    return count;
  }
}
