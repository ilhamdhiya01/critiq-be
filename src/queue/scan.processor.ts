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
import { PullsService } from '../modules/pulls/pulls.service';
import { parsePatch } from './diff/diff-parser';
import { detectLanguage } from './rules/language-detector';
import { isIgnoredPath } from './rules/path-filter';
import { runRulesForFile } from './rules/rule-runner';
import { RULES } from './rules/rules';
import { LocatedHit, dedupeFindings } from './dedupe-findings';
import {
  classifyProviderError,
  sanitizeErrorMessage,
  ScanFailure,
} from './scan-errors';
import { ScanJobPayload } from './scan-payload.dto';
import { SCAN_QUEUE_NAME } from './scan-queue.service';

const MAX_FINDINGS_PER_SCAN = 500;
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

    // 3. Size guard + parse.
    await job.updateProgress({ step: 'parse', pct: 35 });
    const maxDiffBytes =
      this.configService.getOrThrow<number>('scan.maxDiffBytes');
    const scannableFiles = diff.files.filter(
      (file) => file.patch !== null && !isIgnoredPath(file.path),
    );
    // File rules judge a path, not its contents, so they must also see files
    // with no patch — which is exactly how a real credential file arrives.
    // Providers omit the patch for binary blobs and oversized diffs, so
    // filtering on `patch !== null` first would make
    // secret.sensitive_file_added blind to a genuine 2048-bit private key
    // while still passing on a small fixture.
    const fileRuleCandidates = diff.files.filter(
      (file) => !isIgnoredPath(file.path),
    );
    // Counted over the files that will actually be scanned — generated
    // files (lockfiles, dist/) shouldn't push a normal PR over the limit.
    const diffBytes = scannableFiles.reduce(
      (sum, file) => sum + Buffer.byteLength(file.patch ?? '', 'utf8'),
      0,
    );
    if (diffBytes > maxDiffBytes) {
      throw new ScanFailure(
        ScanErrorCode.DIFF_TOO_LARGE,
        `Diff is ${diffBytes} bytes, above the ${maxDiffBytes}-byte limit.`,
      );
    }
    if (diff.truncated) {
      this.logger.warn('scan.diff_truncated', log);
    }

    // 4. Run rules: file rules on every kept file, line rules on the ones
    // with a parseable patch.
    await job.updateProgress({ step: 'rules', pct: 60 });
    const rulesStartedAt = Date.now();
    const budgetState = { elapsedMs: 0 };
    const hits: LocatedHit[] = [];
    let ruleRuns = 0;
    let ruleCrashes = 0;
    let budgetExceeded = false;

    const fileRules = RULES.filter((rule) => rule.kind === 'file');
    const lineRules = RULES.filter((rule) => rule.kind !== 'file');

    for (const file of fileRuleCandidates) {
      const result = runRulesForFile({
        rules: fileRules,
        filePath: file.path,
        language: detectLanguage(file.path),
        // File rules ignore these by definition; passing none keeps it
        // obvious that a file rule deciding on content would be a bug.
        addedLines: [],
        budgetState,
        status: file.status,
        previousPath: file.previousPath,
      });
      ruleRuns += result.ruleRuns;
      for (const crash of result.crashes) {
        ruleCrashes += 1;
        this.logger.warn('rule.crash', {
          ...log,
          ...crash,
          filePath: file.path,
        });
      }
      for (const hit of result.hits) {
        hits.push({ ...hit, filePath: file.path });
      }
    }

    for (const file of scannableFiles) {
      const addedLines = parsePatch(file.patch ?? '')
        .flatMap((hunk) => hunk.lines)
        .flatMap((line) =>
          line.type === 'add' && line.newLine !== null
            ? [{ newLine: line.newLine, text: line.text }]
            : [],
        );
      if (addedLines.length === 0) {
        continue;
      }

      const result = runRulesForFile({
        rules: lineRules,
        filePath: file.path,
        language: detectLanguage(file.path),
        addedLines,
        budgetState,
        status: file.status,
        previousPath: file.previousPath,
        sizeBytes: Buffer.byteLength(file.patch ?? '', 'utf8'),
      });
      ruleRuns += result.ruleRuns;
      for (const crash of result.crashes) {
        ruleCrashes += 1;
        this.logger.warn('rule.crash', {
          ...log,
          ...crash,
          filePath: file.path,
        });
      }
      // Debug level, and carrying only the reason — never the value that was
      // rejected. This is the feedback loop for tuning ValueFilter: a rule
      // firing on real credentials that get filtered shows up here.
      for (const rejected of result.filtered) {
        this.logger.debug('secret.filtered', {
          ...log,
          ...rejected,
          filePath: file.path,
        });
      }
      for (const hit of result.hits) {
        hits.push({ ...hit, filePath: file.path });
      }

      if (result.budgetExceeded) {
        budgetExceeded = true;
        this.logger.warn('rule.budget_exceeded', {
          ...log,
          filePath: file.path,
        });
        break;
      }
      this.assertWithinDeadline(deadline);
    }
    const rulesMs = Date.now() - rulesStartedAt;

    if (ruleRuns > 0 && ruleCrashes === ruleRuns) {
      throw new ScanFailure(
        ScanErrorCode.RULE_CRASH,
        `All ${ruleRuns} rule executions crashed.`,
      );
    }

    // 5. Dedupe + cap.
    const deduped = dedupeFindings(hits).sort(
      (a, b) =>
        a.filePath.localeCompare(b.filePath) || a.lineStart - b.lineStart,
    );
    const findings = deduped.slice(0, MAX_FINDINGS_PER_SCAN);
    const findingsTruncated =
      budgetExceeded || deduped.length > MAX_FINDINGS_PER_SCAN;

    // 6. Persist atomically. The conditional status update is the guard
    // against a newer push having superseded this scan mid-run: if the row
    // is no longer RUNNING, nothing is written (no findings, no
    // latestScanId move). Being one transaction also makes a retry after a
    // crash idempotent — either everything committed (and the retry's
    // claim step sees DONE) or nothing did.
    await job.updateProgress({ step: 'persist', pct: 90 });
    const finishedAt = new Date();
    const persisted = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.scan.updateMany({
        where: { id: scanId, status: ScanStatus.RUNNING },
        data: {
          status: ScanStatus.DONE,
          finishedAt,
          diffBytes,
          filesChanged: diff.files.length,
          findingsCount: findings.length,
          criticalCount: findings.length,
          findingsTruncated,
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
      if (findings.length > 0) {
        await tx.finding.createMany({
          data: findings.map((finding) => ({
            ...finding,
            organizationId,
            scanId,
            source: FindingSource.STATIC,
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
      criticalCount: findings.length,
      durationMs,
    });
    this.logger.info('scan.metrics', {
      ...log,
      durationMs,
      diffBytes,
      filesChanged: diff.files.length,
      filesSkipped: diff.files.length - scannableFiles.length,
      findings: findings.length,
      rulesMs,
    });
    if (findings.length > 0) {
      // One per scan, never per finding.
      this.logger.warn('notification.pull_critical_found', {
        ...log,
        criticalCount: findings.length,
      });
    }

    // 8. TODO: emit `scan.done` via EventEmitter2 once a consumer exists
    // (AI summary v1.5.1, quality-gate status check v1.5.3).
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
