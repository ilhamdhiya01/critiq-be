import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, UnrecoverableError } from 'bullmq';
import Redis from 'ioredis';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import { Logger } from 'winston';
import { PrismaService } from '../common/prisma/prisma.service';
import { REDIS_CLIENT } from '../common/redis/redis.constants';
import {
  FindingSeverity,
  FindingSource,
  ScanErrorCode,
  ScanStatus,
} from '../generated/prisma/enums';
import { PullRequestDiffDto } from '../modules/pulls/dto/pull-request-diff.dto';
import { AiScanService } from '../modules/ai/scan/ai-scan.service';
import { PullsService } from '../modules/pulls/pulls.service';
import { analyzeDiff } from './analyze-diff';
import { categoryForRule } from './finding-category';
import {
  classifyProviderError,
  sanitizeErrorMessage,
  ScanFailure,
} from './scan-errors';
import { ScanJobPayload } from './scan-payload.dto';
import { SCAN_QUEUE_NAME } from './scan-queue.service';

const SCAN_FAILED_NOTIFY_THROTTLE_SECONDS = 3600;

type LogContext = Record<string, unknown>;

// Runs only in the worker process (WorkerModule) — never imported by
// AppModule, so the HTTP app enqueues but never executes scans.
@Processor(SCAN_QUEUE_NAME)
export class ScanProcessor
  extends WorkerHost
  implements OnApplicationBootstrap
{
  constructor(
    private readonly prisma: PrismaService,
    private readonly pullsService: PullsService,
    private readonly aiScanService: AiScanService,
    private readonly configService: ConfigService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
  ) {
    super();
  }

  // @Processor's options are evaluated at import time, before ConfigService
  // exists — set concurrency on the live Worker instead.
  onApplicationBootstrap() {
    this.worker.concurrency =
      this.configService.getOrThrow<number>('scan.concurrency');
  }

  async process(job: Job<ScanJobPayload>): Promise<void> {
    const jobStartedAt = Date.now();
    const deadline =
      jobStartedAt + this.configService.getOrThrow<number>('scan.jobTimeoutMs');
    const { scanId, organizationId, repositoryId, pullId } = job.data;
    const log: LogContext = {
      orgId: organizationId,
      repoId: repositoryId,
      pullId,
      scanId,
      jobId: job.id,
      attemptsMade: job.attemptsMade,
    };

    // 1. Claim. RUNNING is accepted too, so a BullMQ retry (or a stalled
    // job re-picked after a worker/Redis restart) resumes its own scan.
    // Anything else — SUPERSEDED by a newer push, already DONE/FAILED, or
    // the row gone with its deleted PR — means there is nothing to do.
    const claimed = await this.prisma.scan.updateMany({
      where: {
        id: scanId,
        status: { in: [ScanStatus.QUEUED, ScanStatus.RUNNING] },
      },
      data: { status: ScanStatus.RUNNING, startedAt: new Date() },
    });
    if (claimed.count === 0) {
      this.logger.info('scan.skipped_not_runnable', log);
      return;
    }

    // 2. Fetch diff (reuses PullsService.getDiff: credential resolution,
    // integration-state check, both providers).
    await job.updateProgress({ step: 'fetch_diff', pct: 10 });
    const diff = await this.fetchDiff(job.data, log);
    this.assertWithinDeadline(deadline);

    // 3–5. Filter, parse, run rules, classify suppression, dedupe, cap —
    // all in analyzeDiff (pure, replayable in tests).
    await job.updateProgress({ step: 'rules', pct: 35 });
    const analysis = analyzeDiff(diff.files, {
      maxDiffBytes: this.configService.getOrThrow<number>('scan.maxDiffBytes'),
      afterFile: () => this.assertWithinDeadline(deadline),
    });
    if (analysis.diffTooLarge) {
      throw new ScanFailure(
        ScanErrorCode.DIFF_TOO_LARGE,
        `Diff is ${analysis.diffBytes} bytes, above the scan size limit.`,
      );
    }
    if (diff.truncated) {
      this.logger.warn('scan.diff_truncated', log);
    }
    for (const crash of analysis.crashes) {
      this.logger.warn('rule.crash', { ...log, ...crash });
    }
    // Debug level, and carrying only the reason — never the value that was
    // rejected. This is the feedback loop for tuning ValueFilter.
    for (const rejected of analysis.filtered) {
      this.logger.debug('secret.filtered', { ...log, ...rejected });
    }
    if (analysis.budgetExceededAt) {
      this.logger.warn('rule.budget_exceeded', {
        ...log,
        filePath: analysis.budgetExceededAt,
      });
    }
    if (
      analysis.ruleRuns > 0 &&
      analysis.crashes.length === analysis.ruleRuns
    ) {
      throw new ScanFailure(
        ScanErrorCode.RULE_CRASH,
        `All ${analysis.ruleRuns} rule executions crashed.`,
      );
    }

    // 6. Persist atomically. The conditional status update is the guard
    // against a newer push having superseded this scan mid-run: if the row
    // is no longer RUNNING, nothing is written (no findings, no
    // latestScanId move). Being one transaction also makes a retry after a
    // crash idempotent — either everything committed (and the retry's
    // claim step sees DONE) or nothing did.
    await job.updateProgress({ step: 'persist', pct: 90 });
    const finishedAt = new Date();
    const toWrite = [...analysis.active, ...analysis.suppressed];
    const persisted = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.scan.updateMany({
        where: { id: scanId, status: ScanStatus.RUNNING },
        data: {
          status: ScanStatus.DONE,
          finishedAt,
          diffBytes: analysis.diffBytes,
          filesChanged: analysis.filesChanged,
          // Active findings only, and the real totals before the storage
          // cap — suppressed findings never count toward either.
          findingsCount: analysis.activeCount,
          criticalCount: analysis.activeCount,
          findingsTruncated: analysis.findingsTruncated,
          suppressedCount: analysis.suppressedCount,
          suppressedTruncated: analysis.suppressedTruncated,
          // rulesetVersion is deliberately NOT written here. It is set at
          // enqueue (ScanQueueService) and describes the ruleset the scan
          // was created under, which is what the stale-ruleset check
          // compares against. Re-stamping it at persist time would let a
          // scan created under the old ruleset but executed by an already-
          // upgraded worker record the new version — and the next webhook
          // for that sha would then wrongly conclude it is up to date,
          // silently defeating rescans for the length of a rollout.
          errorCode: null,
          errorMessage: null,
        },
      });
      if (updated.count === 0) {
        return false;
      }
      if (toWrite.length > 0) {
        await tx.finding.createMany({
          data: toWrite.map((finding) => ({
            ...finding,
            organizationId,
            scanId,
            source: FindingSource.STATIC,
            category: categoryForRule(finding.ruleId),
            // Every rule in this release is Critical (Rule.severity is the
            // literal 'critical'); the enum carries the full range for later.
            severity: FindingSeverity.CRITICAL,
          })),
        });
      }
      await tx.pullRequest.update({
        where: { id: pullId },
        data: { latestScanId: scanId },
      });
      return true;
    });

    if (!persisted) {
      this.logger.info('scan.superseded_during_run', log);
      return;
    }

    // 7. Audit / notification stand-ins — structured logs until the
    // AuditLog model and notifications module exist.
    const durationMs = Date.now() - jobStartedAt;
    this.logger.info('audit.scan_completed', {
      ...log,
      criticalCount: analysis.activeCount,
      suppressedCount: analysis.suppressedCount,
      durationMs,
    });
    this.logger.info('scan.metrics', {
      ...log,
      durationMs,
      diffBytes: analysis.diffBytes,
      filesChanged: analysis.filesChanged,
      filesSkipped: analysis.filesSkipped,
      findings: analysis.activeCount,
      suppressed: analysis.suppressedCount,
      rulesMs: analysis.rulesMs,
    });
    // Active findings only: a scan whose every finding is suppressed is not
    // news. One per scan, never per finding.
    if (analysis.activeCount > 0) {
      this.logger.warn('notification.pull_critical_found', {
        ...log,
        criticalCount: analysis.activeCount,
      });
    }

    // 8. AI review (v1.5.1 langkah 2) — decided and enqueued here rather
    // than via a `scan.done` event (no EventEmitter yet; the quality-gate
    // check of v1.5.3 is the next consumer). Its outcome lands on the scan's
    // ai* columns; a failure here must never fail the static scan.
    try {
      await this.aiScanService.maybeEnqueue(scanId);
    } catch (error) {
      this.logger.error('ai.enqueue_failed', {
        ...log,
        errorName: error instanceof Error ? error.name : 'Unknown',
      });
    }
    await job.updateProgress({ step: 'done', pct: 100 });
  }

  // BullMQ emits `failed` after every failed attempt, including ones that
  // will be retried — only the final one may mark the Scan FAILED.
  @OnWorkerEvent('failed')
  async onFailed(job: Job<ScanJobPayload> | undefined, error: Error) {
    if (!job) {
      return;
    }
    const { scanId, organizationId, repositoryId, pullId } = job.data;
    const log: LogContext = {
      orgId: organizationId,
      repoId: repositoryId,
      pullId,
      scanId,
      jobId: job.id,
      attemptsMade: job.attemptsMade,
    };

    const isFinal =
      error instanceof UnrecoverableError ||
      job.attemptsMade >= (job.opts.attempts ?? 1);
    if (!isFinal) {
      this.logger.warn('scan.attempt_failed', {
        ...log,
        errorName: error.name,
      });
      return;
    }

    const errorCode =
      error instanceof ScanFailure
        ? error.code
        : classifyProviderError(error) === 'retryable'
          ? ScanErrorCode.PROVIDER_UNREACHABLE
          : null;

    try {
      const finalized = await this.prisma.$transaction(async (tx) => {
        const updated = await tx.scan.updateMany({
          where: {
            id: scanId,
            status: { in: [ScanStatus.QUEUED, ScanStatus.RUNNING] },
          },
          data: {
            status: ScanStatus.FAILED,
            errorCode,
            errorMessage: sanitizeErrorMessage(error.message),
            finishedAt: new Date(),
          },
        });
        if (updated.count === 0) {
          return false;
        }
        await tx.pullRequest.update({
          where: { id: pullId },
          data: { latestScanId: scanId },
        });
        return true;
      });
      if (!finalized) {
        return;
      }

      this.logger.error('scan.failed', { ...log, errorCode });
      await this.notifyScanFailed(log, errorCode);
    } catch (finalizeError) {
      // An event handler must never throw (nothing awaits it); log so a DB
      // outage during finalization is at least visible.
      this.logger.error('scan.failed_finalize_error', {
        ...log,
        errorName:
          finalizeError instanceof Error ? finalizeError.name : 'Unknown',
      });
    }
  }

  private async fetchDiff(
    payload: ScanJobPayload,
    log: LogContext,
  ): Promise<PullRequestDiffDto> {
    try {
      return await this.pullsService.getDiff(
        payload.organizationId,
        payload.repositoryId,
        payload.pullId,
      );
    } catch (error) {
      if (classifyProviderError(error) === 'credential') {
        this.logger.warn('notification.integration_token_invalid', log);
        throw new ScanFailure(
          ScanErrorCode.TOKEN_EXPIRED,
          'The code host rejected the organization credential.',
        );
      }
      // Provider 5xx/timeouts and anything unexpected: let BullMQ retry
      // with backoff; the failed handler maps exhaustion to an error code.
      throw error;
    }
  }

  private assertWithinDeadline(deadline: number) {
    if (Date.now() > deadline) {
      throw new ScanFailure(
        ScanErrorCode.TIMEOUT,
        'Scan exceeded SCAN_JOB_TIMEOUT_MS.',
      );
    }
  }

  // Log stand-in for the future notifications module, throttled to one per
  // PR per hour so a flapping provider doesn't spam admins.
  private async notifyScanFailed(
    log: LogContext,
    errorCode: ScanErrorCode | null,
  ) {
    const acquired = await this.redis.set(
      `notify:scan_failed:${String(log.pullId)}`,
      '1',
      'EX',
      SCAN_FAILED_NOTIFY_THROTTLE_SECONDS,
      'NX',
    );
    if (acquired === 'OK') {
      this.logger.warn('notification.scan_failed', { ...log, errorCode });
    }
  }
}
