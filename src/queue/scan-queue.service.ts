import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import { Logger } from 'winston';
import { PrismaService } from '../common/prisma/prisma.service';
import { Prisma } from '../generated/prisma/client';
import {
  AiScanStatus,
  DiffMode,
  FullReason,
  Provider,
  ReviewPolicy,
  ScanStatus,
  ScanTrigger,
} from '../generated/prisma/enums';
import { AI_PROMPT_VERSION } from '../modules/ai/scan/ai-prompt.constants';
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
  // Force a FULL scan (manual rescan `{full: true}`, regenerate
  // `{force: true}`) instead of an incremental one.
  full?: boolean;
}

export interface ScanModeDecision {
  diffMode: DiffMode;
  fullReason: FullReason | null;
  baseScanId: string | null;
  prevHeadSha: string | null;
}

// FULL or INCREMENTAL for a new scan (v1.5.1 langkah 3), from the DB only —
// enqueue runs inside the webhook request, which must not call the provider.
// A force-push cannot be seen here; the worker checks ancestry with the
// compare API and turns the scan FULL (FORCE_PUSH) when needed.
// AI outcomes after which the base scan is still a fine incremental base:
// the review was skipped for the size of the whole diff or a spent budget,
// and a small next push is exactly what can still get one.
const INCREMENTAL_AFTER_AI_SKIP: AiScanStatus[] = [
  AiScanStatus.SKIPPED_TOO_LARGE,
  AiScanStatus.BUDGET_EXCEEDED,
];

export function decideScanMode(input: {
  base: {
    id: string;
    headSha: string;
    rulesetVersion: string;
    aiPromptVersion: string | null;
    aiStatus: AiScanStatus | null;
    // The base scan has an AI summary (a completed or cached review).
    aiReviewed: boolean;
  } | null;
  full: boolean;
  effectivePolicy: ReviewPolicy | null;
  // Provider selected and consent given — the AI will review this scan.
  aiEnabled: boolean;
}): ScanModeDecision {
  const full = (fullReason: FullReason): ScanModeDecision => ({
    diffMode: DiffMode.FULL,
    fullReason,
    baseScanId: input.base?.id ?? null,
    prevHeadSha: null,
  });
  if (!input.base) {
    return full(FullReason.FIRST_SCAN);
  }
  if (input.full) {
    return full(FullReason.MANUAL);
  }
  if (input.base.rulesetVersion !== RULESET_VERSION) {
    return full(FullReason.RULESET_CHANGED);
  }
  // Only when the AI runs on this PR: a Manual-only branch never sent a
  // prompt, so a prompt change is irrelevant to it.
  if (
    input.base.aiPromptVersion !== null &&
    input.base.aiPromptVersion !== AI_PROMPT_VERSION &&
    input.effectivePolicy !== ReviewPolicy.MANUAL_ONLY
  ) {
    return full(FullReason.PROMPT_CHANGED);
  }
  // The AI reviews an incremental scan as a delta against the previous
  // review. With no previous review (the base ran before the AI was set up,
  // or its AI step failed) there is nothing to be a delta of: the AI would
  // only ever see the latest push. Scan in full to give it the whole PR —
  // FIRST_SCAN, as this is the first scan that reviews the PR completely.
  if (
    input.aiEnabled &&
    input.effectivePolicy !== ReviewPolicy.MANUAL_ONLY &&
    !input.base.aiReviewed &&
    !(
      input.base.aiStatus !== null &&
      INCREMENTAL_AFTER_AI_SKIP.includes(input.base.aiStatus)
    )
  ) {
    return full(FullReason.FIRST_SCAN);
  }
  return {
    diffMode: DiffMode.INCREMENTAL,
    fullReason: null,
    baseScanId: input.base.id,
    prevHeadSha: input.base.headSha,
  };
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
      select: {
        id: true,
        status: true,
        attempt: true,
        rulesetVersion: true,
      },
    });

    // A finished scan under an older ruleset is not a duplicate: the rules
    // that would flag this diff today did not exist when it ran. Without
    // this, fixing a detection gap leaves every already-scanned PR stuck on
    // the old result until someone pushes a new commit.
    //
    // Gated on DONE deliberately. A QUEUED/RUNNING scan under an old
    // ruleset is still in flight, and creating a new one would supersede it
    // below — churning work to replace a result that was about to arrive.
    // Let it finish; the next webhook for that sha picks up the new rules.
    const rulesetIsStale =
      latestForSha?.status === ScanStatus.DONE &&
      latestForSha.rulesetVersion !== RULESET_VERSION;

    if (
      input.trigger === ScanTrigger.WEBHOOK &&
      latestForSha &&
      WEBHOOK_DEDUPE_STATUSES.includes(latestForSha.status) &&
      !rulesetIsStale
    ) {
      return {
        scanId: latestForSha.id,
        status: latestForSha.status,
        deduplicated: true,
      };
    }

    // Records *why* this scan exists. A webhook that only got here because
    // the ruleset moved on is a rescan, not ordinary webhook traffic, and
    // the distinction matters when reading the scan history of a PR.
    const trigger =
      input.trigger === ScanTrigger.WEBHOOK && rulesetIsStale
        ? ScanTrigger.RESCAN
        : input.trigger;

    await this.cancelPending(input.pullId);

    // The last finished scan of this PR is what an incremental scan diffs
    // from and carries findings forward from.
    const [base, pull] = await Promise.all([
      this.prisma.scan.findFirst({
        where: { pullId: input.pullId, status: ScanStatus.DONE },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          headSha: true,
          rulesetVersion: true,
          aiPromptVersion: true,
          aiStatus: true,
          aiSummary: { select: { id: true } },
        },
      }),
      this.prisma.pullRequest.findUnique({
        where: { id: input.pullId },
        select: {
          effectivePolicy: true,
          organization: { select: { aiProvider: true, aiConsentAt: true } },
        },
      }),
    ]);
    const mode = decideScanMode({
      base: base ? { ...base, aiReviewed: base.aiSummary !== null } : null,
      full: input.full ?? false,
      effectivePolicy: pull?.effectivePolicy ?? null,
      aiEnabled: Boolean(
        pull?.organization.aiProvider && pull.organization.aiConsentAt,
      ),
    });

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
          trigger,
          attempt: (latestForSha?.attempt ?? 0) + 1,
          rulesetVersion: RULESET_VERSION,
          ...mode,
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
      trigger,
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
      trigger,
      diffMode: mode.diffMode,
      fullReason: mode.fullReason,
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
