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
  AiScanStatus,
  DiffMode,
  FindingSeverity,
  FindingSource,
  FindingStatus,
  FullReason,
  ScanErrorCode,
  ScanStatus,
} from '../generated/prisma/enums';
import { PullRequestDiffDto } from '../modules/pulls/dto/pull-request-diff.dto';
import { AiScanService } from '../modules/ai/scan/ai-scan.service';
import { PullsService } from '../modules/pulls/pulls.service';
import { analyzeDiff } from './analyze-diff';
import { categoryForRule } from './finding-category';
import {
  loadBaseFindings,
  loadRecentResolved,
  logWindowMisses,
} from './lifecycle/lifecycle-context';
import {
  CandidateFinding,
  planFindings,
  StoredFinding,
} from './lifecycle/plan-findings';
import {
  notifyIfAllCriticalResolved,
  recomputeScanCounts,
} from './lifecycle/scan-counts';
import {
  classifyProviderError,
  providerErrorDetail,
  sanitizeErrorMessage,
  ScanFailure,
} from './scan-errors';
import { cachedHeadFileContents } from './head-file-cache';
import { detectLanguage } from './rules/language-detector';
import { SYNTAX_RULE_ID } from './rules/syntax/syntax-check';
import {
  runSyntaxChecks,
  syntaxCheckFiles,
  SyntaxStepResult,
} from './rules/syntax/syntax-step';
import { ScanJobPayload } from './scan-payload.dto';
import { SCAN_QUEUE_NAME } from './scan-queue.service';
import { classifySuppression } from './suppression';

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

    // 2. Fetch the diff this scan reads: the whole PR (FULL), or only what
    // changed since the base scan's head (INCREMENTAL, v1.5.1 langkah 3).
    // A base that is no longer an ancestor of head (force-push, rebase)
    // turns the scan FULL here — enqueue cannot call the provider.
    await job.updateProgress({ step: 'fetch_diff', pct: 10 });
    const scanRow = await this.prisma.scan.findUniqueOrThrow({
      where: { id: scanId },
      select: {
        headSha: true,
        diffMode: true,
        baseScanId: true,
        prevHeadSha: true,
      },
    });
    let diffMode = scanRow.diffMode;
    let diff: { files: PullRequestDiffDto['files']; truncated: boolean };
    if (diffMode === DiffMode.INCREMENTAL && scanRow.prevHeadSha) {
      const compared = await this.fetchCompare(
        job.data,
        scanRow.prevHeadSha,
        scanRow.headSha,
        log,
      );
      if (compared.ancestor) {
        diff = compared;
      } else {
        diffMode = DiffMode.FULL;
        await this.prisma.scan.update({
          where: { id: scanId },
          data: {
            diffMode: DiffMode.FULL,
            fullReason: FullReason.FORCE_PUSH,
            prevHeadSha: null,
          },
        });
        this.logger.info('scan.force_push_detected', log);
        diff = await this.fetchDiff(job.data, log);
      }
    } else {
      diff = await this.fetchDiff(job.data, log);
    }
    // Display only, once per repository — never affects the scan.
    await this.pullsService
      .fillMissingLanguage(organizationId, repositoryId)
      .catch((error: unknown) =>
        this.logger.warn('scan.language_lookup_failed', {
          ...log,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
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

    const base = scanRow.baseScanId
      ? await loadBaseFindings(this.prisma, scanRow.baseScanId)
      : [];

    // 5b. Syntax (code.syntax_error): the changed files themselves, parsed
    // whole — a broken brace is invisible to line rules.
    await job.updateProgress({ step: 'syntax', pct: 60 });
    const syntax = await this.checkChangedFilesSyntax(
      job.data,
      scanRow.headSha,
      diff.files,
      base,
      deadline,
      log,
    );
    const syntaxFindings = syntax.hits.map((hit) => ({
      ...hit,
      suppressedReason: classifySuppression({
        ruleId: hit.ruleId,
        filePath: hit.filePath,
        language: detectLanguage(hit.filePath),
      }),
    }));
    const syntaxSuppressed = syntaxFindings.filter(
      (finding) => finding.suppressedReason !== null,
    ).length;

    // 6. Lifecycle (v1.5.1 langkah 3): continue or close the base scan's
    // findings, and give this scan's own findings NEW or REOPENED.
    await job.updateProgress({ step: 'persist', pct: 90 });
    const candidates: CandidateFinding[] = [
      ...analysis.active,
      ...analysis.suppressed,
      ...syntaxFindings,
    ].map((finding) => ({
      ...finding,
      source: FindingSource.STATIC,
      category: categoryForRule(finding.ruleId),
      // Every rule in this release is Critical (Rule.severity is the
      // literal 'critical'); the enum carries the full range for later.
      severity: FindingSeverity.CRITICAL,
      confidence: null,
    }));
    // Incremental: a syntax finding in a file the check just decided is not
    // carried by line — the fix may be a brace added elsewhere. It is
    // matched by fingerprint instead: still broken → PERSISTED, parses →
    // RESOLVED. Undecided files (fetch failed, capped) carry as before.
    const reevaluated =
      diffMode === DiffMode.INCREMENTAL
        ? base.filter(
            (finding) =>
              finding.source === FindingSource.STATIC &&
              finding.ruleId === SYNTAX_RULE_ID &&
              syntax.decidedOldPaths.has(finding.filePath),
          )
        : [];
    const recent = await loadRecentResolved(this.prisma, pullId, scanId);
    const plan = planFindings({
      scanId,
      candidates,
      // Incremental: every base finding, static and AI, goes through the
      // diff. Full with a base: static ones are matched by fingerprint;
      // the AI step matches its own.
      carry:
        diffMode === DiffMode.INCREMENTAL
          ? {
              base: base.filter((finding) => !reevaluated.includes(finding)),
              files: diff.files,
            }
          : undefined,
      match:
        diffMode === DiffMode.FULL && base.length > 0
          ? {
              base: base.filter((f) => f.source === FindingSource.STATIC),
            }
          : reevaluated.length > 0
            ? { base: reevaluated }
            : undefined,
      recentResolved: recent.rows,
    });
    // Suppressed static findings carried over from the base scan (kept
    // visible, never counted) join this scan's own suppressed total.
    const carriedSuppressed =
      diffMode === DiffMode.INCREMENTAL
        ? plan.rows.filter(
            (row) =>
              row.status === FindingStatus.PERSISTED &&
              row.source === FindingSource.STATIC &&
              row.suppressedReason !== null,
          ).length
        : 0;

    // 7. Persist atomically. The conditional status update is the guard
    // against a newer push having superseded this scan mid-run: if the row
    // is no longer RUNNING, nothing is written (no findings, no
    // latestScanId move). Being one transaction also makes a retry after a
    // crash idempotent — either everything committed (and the retry's
    // claim step sees DONE) or nothing did.
    const finishedAt = new Date();
    const counts = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.scan.updateMany({
        where: { id: scanId, status: ScanStatus.RUNNING },
        data: {
          status: ScanStatus.DONE,
          finishedAt,
          diffBytes: analysis.diffBytes,
          filesChanged: analysis.filesChanged,
          findingsTruncated: analysis.findingsTruncated,
          suppressedCount:
            analysis.suppressedCount + syntaxSuppressed + carriedSuppressed,
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
        return null;
      }
      if (plan.rows.length > 0) {
        await tx.finding.createMany({
          data: plan.rows.map((row) => ({
            ...row,
            organizationId,
            scanId,
            pullId,
          })),
        });
      }
      const recomputed = await recomputeScanCounts(tx, scanId);
      await tx.pullRequest.update({
        where: { id: pullId },
        data: { latestScanId: scanId },
      });
      return recomputed;
    });

    if (!counts) {
      this.logger.info('scan.superseded_during_run', log);
      return;
    }
    await logWindowMisses(
      this.prisma,
      this.logger,
      {
        pullId,
        currentScanId: scanId,
        windowScanIds: recent.windowScanIds,
        fingerprints: plan.newFingerprints,
      },
      log,
    );

    // Audit / notification stand-ins — structured logs until the AuditLog
    // model and notifications module exist.
    const durationMs = Date.now() - jobStartedAt;
    this.logger.info('audit.scan_completed', {
      ...log,
      diffMode,
      criticalCount: counts.criticalCount,
      newCount: counts.newCount,
      persistedCount: counts.persistedCount,
      reopenedCount: counts.reopenedCount,
      resolvedCount: counts.resolvedCount,
      durationMs,
    });
    this.logger.info('scan.metrics', {
      ...log,
      durationMs,
      diffMode,
      diffBytes: analysis.diffBytes,
      filesChanged: analysis.filesChanged,
      filesSkipped: analysis.filesSkipped,
      findings: analysis.activeCount + syntaxFindings.length - syntaxSuppressed,
      suppressed: analysis.suppressedCount + syntaxSuppressed,
      rulesMs: analysis.rulesMs,
    });
    // Only criticals this push brought (NEW) or brought back (REOPENED):
    // PERSISTED ones were notified when they first appeared.
    const freshCritical = plan.rows.filter(
      (row) =>
        row.source === FindingSource.STATIC &&
        row.suppressedReason === null &&
        row.severity === FindingSeverity.CRITICAL &&
        (row.status === FindingStatus.NEW ||
          row.status === FindingStatus.REOPENED),
    ).length;
    if (freshCritical > 0) {
      this.logger.warn('notification.pull_critical_found', {
        ...log,
        criticalCount: freshCritical,
      });
    }

    // 8. AI review (v1.5.1 langkah 2) — decided and enqueued here rather
    // than via a `scan.done` event (no EventEmitter yet; the quality-gate
    // check of v1.5.3 is the next consumer). Its outcome lands on the scan's
    // ai* columns; a failure here must never fail the static scan.
    let aiStatus: AiScanStatus | null = null;
    try {
      aiStatus = await this.aiScanService.maybeEnqueue(scanId);
    } catch (error) {
      this.logger.error('ai.enqueue_failed', {
        ...log,
        errorName: error instanceof Error ? error.name : 'Unknown',
      });
    }
    // The last step of the scan decides "all criticals resolved": here when
    // no AI review follows, otherwise at the end of the AI step.
    if (aiStatus !== AiScanStatus.QUEUED) {
      // Re-read: a cached AI result may have just changed the counts.
      const settled = await this.prisma.scan.findUnique({
        where: { id: scanId },
        select: { criticalCount: true },
      });
      await notifyIfAllCriticalResolved(
        this.prisma,
        this.redis,
        this.logger,
        {
          id: scanId,
          headSha: scanRow.headSha,
          criticalCount: settled?.criticalCount ?? counts.criticalCount,
        },
        log,
      );
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

  private async fetchCompare(
    payload: ScanJobPayload,
    fromSha: string,
    toSha: string,
    log: LogContext,
  ) {
    try {
      return await this.pullsService.getCompareDiff(
        payload.organizationId,
        payload.repositoryId,
        payload.pullId,
        fromSha,
        toSha,
      );
    } catch (error) {
      this.rethrowProviderError(error, log);
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
      this.rethrowProviderError(error, log);
    }
  }

  // Provider failures retrying cannot fix end the scan at once: a refused
  // credential (an Admin must act) or a request the provider rejected as
  // malformed (the same request would be rejected again). Provider
  // 5xx/timeouts and anything unexpected: let BullMQ retry with backoff;
  // the failed handler maps exhaustion to an error code.
  private rethrowProviderError(error: unknown, log: LogContext): never {
    const kind = classifyProviderError(error);
    if (kind === 'credential') {
      this.logger.warn('notification.integration_token_invalid', log);
      throw new ScanFailure(
        ScanErrorCode.TOKEN_EXPIRED,
        'The code host rejected the organization credential.',
      );
    }
    if (kind === 'rejected') {
      const detail = providerErrorDetail(error);
      throw new ScanFailure(
        ScanErrorCode.PROVIDER_REJECTED,
        `The code host rejected the request${detail ? `: ${detail}` : ''}.`,
      );
    }
    throw error;
  }

  // Best effort: a fetch failure or a parser surprise skips the check (and
  // is logged) rather than failing the scan — every other rule's verdict
  // still stands. Only the scan deadline propagates.
  private async checkChangedFilesSyntax(
    data: ScanJobPayload,
    headSha: string,
    files: PullRequestDiffDto['files'],
    base: StoredFinding[],
    deadline: number,
    log: LogContext,
  ): Promise<SyntaxStepResult & { decidedOldPaths: Set<string> }> {
    const nothing = {
      hits: [],
      decidedPaths: new Set<string>(),
      decidedOldPaths: new Set<string>(),
      skipped: {},
    };
    const { files: selected, capped } = syntaxCheckFiles(
      files,
      this.configService.getOrThrow<number>('scan.syntaxMaxFiles'),
    );
    if (selected.length === 0) {
      return nothing;
    }
    const brokenBefore = new Set(
      base
        .filter((finding) => finding.ruleId === SYNTAX_RULE_ID)
        .map((finding) => finding.filePath),
    );
    const oldPathOf = (file: (typeof selected)[number]) =>
      file.previousPath ?? file.path;
    try {
      const contents = await cachedHeadFileContents(
        this.redis,
        this.pullsService,
        {
          organizationId: data.organizationId,
          repositoryId: data.repositoryId,
          pullId: data.pullId,
          sha: headSha,
        },
        selected.map((file) => file.path),
      );
      this.assertWithinDeadline(deadline);
      const result = runSyntaxChecks(selected, contents, {
        knownBroken: new Set(
          selected
            .filter((file) => brokenBefore.has(oldPathOf(file)))
            .map((file) => file.path),
        ),
        capped,
        afterFile: () => this.assertWithinDeadline(deadline),
      });
      this.logger.info('syntax.checked', {
        ...log,
        files: selected.length,
        hits: result.hits.length,
        skipped: result.skipped,
      });
      return {
        ...result,
        decidedOldPaths: new Set(
          selected
            .filter((file) => result.decidedPaths.has(file.path))
            .map(oldPathOf),
        ),
      };
    } catch (error) {
      if (error instanceof ScanFailure) {
        throw error;
      }
      this.logger.warn('syntax.check_failed', {
        ...log,
        error: error instanceof Error ? error.name : 'unknown',
      });
      return nothing;
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
