import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, UnrecoverableError } from 'bullmq';
import { createHash } from 'crypto';
import type Redis from 'ioredis';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import { Logger } from 'winston';
import { EncryptionService } from '../common/encryption/encryption.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { REDIS_CLIENT } from '../common/redis/redis.constants';
import {
  AiRiskLevel,
  AiScanStatus,
  DiffMode,
  FindingSource,
  FindingStatus,
} from '../generated/prisma/enums';
import { completeValidated } from '../modules/ai/ai-call';
import { AiError, AiErrorCode, toAiError } from '../modules/ai/ai-error';
import { AiProviderFactory } from '../modules/ai/ai-provider.factory';
import { AiProvider, AiResult } from '../modules/ai/ai-provider.interface';
import { dedupeAiFindings } from '../modules/ai/scan/ai-deduper';
import {
  buildReviewPrompt,
  PromptFileInput,
} from '../modules/ai/scan/ai-prompt-builder';
import {
  AI_PROMPT_VERSION,
  ReportReviewInput,
  RETRY_SYSTEM_SUFFIX,
} from '../modules/ai/scan/ai-prompt.constants';
import { validateAiFindings } from '../modules/ai/scan/ai-result-validator';
import { clampReportReview } from '../modules/ai/scan/report-review-clamp';
import {
  buildAiRows,
  freshCriticalCount,
  loadAiLifecycleContext,
  persistAiResult,
} from '../modules/ai/scan/ai-scan.persistence';
import { logWindowMisses } from './lifecycle/lifecycle-context';
import { notifyIfAllCriticalResolved } from './lifecycle/scan-counts';
import { AiScanService } from '../modules/ai/scan/ai-scan.service';
import { PullsService } from '../modules/pulls/pulls.service';
import { AI_QUEUE_NAME, aiBackoff, AiJobPayload } from './ai-queue.constants';
import { isIgnoredPath, isMustScanPath } from './rules/path-filter';

const HEAD_FILE_CACHE_SECONDS = 60;
const MAX_CONTEXT_FILES = 50;
const RAW_RETENTION_SECONDS = 30 * 86_400;
const MAX_RAW_CHARS = 100_000;
const AUTH_NOTIFY_THROTTLE_SECONDS = 3600;

// Configuration problems found when the job runs (settings changed after
// it was queued) are a state, not a failure.
const NOT_CONFIGURED_CODES: AiErrorCode[] = [
  'not_configured',
  'api_key_required',
  'base_url_required',
];

// A failure that retrying cannot fix; `code` becomes scans.aiErrorCode.
export class AiJobFailure extends UnrecoverableError {
  constructor(readonly code: string) {
    super(`AI review failed: ${code}`);
    this.name = 'AiJobFailure';
  }
}

type LogContext = Record<string, unknown>;

// Runs only in the worker process (WorkerModule). One job = one AI review
// of one DONE static scan. Never touches static findings, and never fails
// the static scan: every outcome lands on the scan's ai* columns.
@Processor(AI_QUEUE_NAME, { settings: { backoffStrategy: aiBackoff } })
export class AiScanProcessor
  extends WorkerHost
  implements OnApplicationBootstrap
{
  constructor(
    private readonly prisma: PrismaService,
    private readonly pullsService: PullsService,
    private readonly aiScanService: AiScanService,
    private readonly aiProviderFactory: AiProviderFactory,
    private readonly encryptionService: EncryptionService,
    private readonly configService: ConfigService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
  ) {
    super();
  }

  onApplicationBootstrap() {
    this.worker.concurrency =
      this.configService.getOrThrow<number>('ai.concurrency');
  }

  async process(job: Job<AiJobPayload>): Promise<void> {
    const { scanId, organizationId, pullId } = job.data;
    const log: LogContext = {
      orgId: organizationId,
      pullId,
      scanId,
      jobId: job.id,
      attemptsMade: job.attemptsMade,
    };

    // 1. Claim. RUNNING too, so a BullMQ retry resumes its own run.
    const claimed = await this.prisma.scan.updateMany({
      where: {
        id: scanId,
        aiStatus: { in: [AiScanStatus.QUEUED, AiScanStatus.RUNNING] },
      },
      data: { aiStatus: AiScanStatus.RUNNING, aiStartedAt: new Date() },
    });
    if (claimed.count === 0) {
      this.logger.info('ai.skipped_not_runnable', log);
      return;
    }

    const scan = await this.prisma.scan.findUniqueOrThrow({
      where: { id: scanId },
      include: {
        pullRequest: {
          select: {
            title: true,
            description: true,
            sourceBranch: true,
            targetBranch: true,
          },
        },
        repository: { select: { path: true } },
        organization: { select: { aiLocale: true } },
      },
    });

    // 2. Provider — the key is decrypted inside the adapter only.
    let provider: AiProvider;
    try {
      provider = await this.aiProviderFactory.for(organizationId);
    } catch (error) {
      const aiError = toAiError(error);
      if (NOT_CONFIGURED_CODES.includes(aiError.code)) {
        await this.prisma.scan.updateMany({
          where: { id: scanId, aiStatus: AiScanStatus.RUNNING },
          data: {
            aiStatus: AiScanStatus.NOT_CONFIGURED,
            aiFinishedAt: new Date(),
          },
        });
        await this.notifyResolvedIfDone(scanId, log);
        return;
      }
      throw new AiJobFailure(aiError.code);
    }

    // 3. Inputs: the same diff the static step read (only the latest push
    // for an INCREMENTAL scan — v1.5.1 langkah 3), this scan's live static
    // findings, the lifecycle blocks, and head-file context.
    const diff =
      scan.diffMode === DiffMode.INCREMENTAL && scan.prevHeadSha
        ? await this.pullsService.getCompareDiff(
            organizationId,
            scan.repositoryId,
            pullId,
            scan.prevHeadSha,
            scan.headSha,
          )
        : await this.pullsService.getDiff(
            organizationId,
            scan.repositoryId,
            pullId,
          );
    const scanFindings = await this.prisma.finding.findMany({
      where: { scanId },
      select: {
        id: true,
        source: true,
        status: true,
        ruleId: true,
        category: true,
        filePath: true,
        lineStart: true,
        lineEnd: true,
        title: true,
        suppressedReason: true,
      },
    });
    const staticFindings = scanFindings.filter(
      (finding) =>
        finding.source === FindingSource.STATIC &&
        finding.status !== FindingStatus.RESOLVED,
    );
    const contextPaths = diff.files
      .filter(
        (file) =>
          file.patch !== null &&
          !isIgnoredPath(file.path) &&
          !isMustScanPath(file.path),
      )
      .slice(0, MAX_CONTEXT_FILES)
      .map((file) => file.path);
    const contents = await this.headFileContents(
      organizationId,
      scan.repositoryId,
      pullId,
      scan.headSha,
      contextPaths,
    );
    const files: PromptFileInput[] = diff.files.map((file) => ({
      path: file.path,
      status: file.status,
      patch: file.patch,
      headLines: contents.get(file.path)?.split('\n') ?? null,
    }));

    const prompt = buildReviewPrompt({
      repoPath: scan.repository.path,
      pullTitle: scan.pullRequest.title,
      pullDescription: scan.pullRequest.description,
      sourceBranch: scan.pullRequest.sourceBranch,
      targetBranch: scan.pullRequest.targetBranch,
      files,
      staticFindings: staticFindings.map((finding) => ({
        ...finding,
        suppressed: finding.suppressedReason !== null,
      })),
      locale: scan.organization.aiLocale,
      contextLines: this.configService.getOrThrow<number>('ai.contextLines'),
      maxInputTokens:
        this.configService.getOrThrow<number>('ai.maxInputTokens'),
      maxOutputTokens:
        this.configService.getOrThrow<number>('ai.maxOutputTokens'),
      timeoutMs: this.configService.getOrThrow<number>('ai.timeoutMs'),
      mode: scan.diffMode === DiffMode.INCREMENTAL ? 'incremental' : 'full',
      lifecycle: {
        resolved: scanFindings.filter(
          (finding) =>
            finding.status === FindingStatus.RESOLVED &&
            finding.suppressedReason === null,
        ),
        // Static persisted findings are already under ALREADY REPORTED.
        persisted: scanFindings.filter(
          (finding) =>
            finding.status === FindingStatus.PERSISTED &&
            finding.source === FindingSource.AI &&
            finding.suppressedReason === null,
        ),
      },
    });

    // 4. Call. invalid_response is retried once inside completeValidated,
    // with an extra instruction; transport errors go back to BullMQ.
    // Overlong text is trimmed before the schema check rather than failing
    // the whole review.
    let completion: AiResult;
    let clamped: string[] = [];
    try {
      completion = await completeValidated(provider, prompt.request, {
        retryRequest: (request) => ({
          ...request,
          system: request.system + RETRY_SYSTEM_SUFFIX,
        }),
        normalize: (toolInput) => {
          const result = clampReportReview(toolInput);
          clamped = result.clamped;
          return result.value;
        },
      });
    } catch (error) {
      const aiError = toAiError(error);
      if (
        aiError.code === 'invalid_response' ||
        aiError.code === 'output_truncated'
      ) {
        await this.keepRawResponse(scanId, aiError, log);
        throw new AiJobFailure(aiError.code);
      }
      if (aiError.retryable) {
        throw aiError;
      }
      throw new AiJobFailure(aiError.code);
    }

    if (clamped.length > 0) {
      this.logger.info('ai.output_clamped', { ...log, fields: clamped });
    }

    // 5. Validate against what was sent, dedupe against static, persist.
    const review = completion.toolInput as ReportReviewInput;
    const validation = validateAiFindings(review.findings, prompt.sentFiles);
    for (const rejected of validation.rejected) {
      this.logger.info('ai.reject', { ...log, reason: rejected.reason });
    }
    const staticActive = staticFindings.filter(
      (finding) => finding.suppressedReason === null,
    );
    const { kept, duplicates } = dedupeAiFindings(
      validation.accepted,
      staticActive,
    );

    // Lifecycle: matched to the base AI findings (FULL), minus what the
    // static step already carried (INCREMENTAL), NEW or REOPENED otherwise.
    const lifecycleContext = await loadAiLifecycleContext(this.prisma, scan);
    const { rows, newFingerprints } = buildAiRows(
      scan,
      kept,
      duplicates,
      lifecycleContext,
      this.configService.get<boolean>('ai.keepDeduped') ?? false,
    );

    const aiProvider = provider.id;
    const aiModel = completion.model;
    const persisted = await this.prisma.$transaction((tx) =>
      persistAiResult(
        tx,
        scan,
        {
          status: AiScanStatus.DONE,
          summaryMd: review.summary,
          riskLevel: review.risk_level.toUpperCase() as AiRiskLevel,
          filesOmitted: prompt.filesOmitted,
          rows,
          total: review.findings.length,
          rejected: validation.rejected.length,
          deduped: duplicates.length,
          provider: aiProvider,
          model: aiModel,
          promptVersion: AI_PROMPT_VERSION,
          tokensIn: completion.usage.inputTokens,
          tokensOut: completion.usage.outputTokens,
        },
        { aiStatus: AiScanStatus.RUNNING },
      ),
    );
    // Tokens were spent either way.
    await this.aiScanService.recordUsage(organizationId, completion.usage);
    if (!persisted) {
      this.logger.info('ai.superseded_during_run', log);
      return;
    }

    // 6. Cache, notification, audit.
    try {
      await this.aiScanService.rememberInCache(
        {
          repositoryId: scan.repositoryId,
          headSha: scan.headSha,
          rulesetVersion: scan.rulesetVersion,
          promptVersion: AI_PROMPT_VERSION,
          provider: aiProvider,
          model: scan.aiModel ?? aiModel,
          diffMode: scan.diffMode,
          prevHeadSha: scan.prevHeadSha,
        },
        scanId,
      );
    } catch {
      this.logger.warn('ai.cache_write_failed', log);
    }

    await logWindowMisses(
      this.prisma,
      this.logger,
      {
        pullId,
        currentScanId: scanId,
        windowScanIds: lifecycleContext.windowScanIds,
        fingerprints: newFingerprints,
      },
      log,
    );

    // Only criticals this push brought or brought back, and only when the
    // static step did not already notify for this scan.
    const aiFresh = freshCriticalCount(rows);
    const staticFresh = scanFindings.filter(
      (finding) =>
        finding.source === FindingSource.STATIC &&
        finding.suppressedReason === null &&
        (finding.status === FindingStatus.NEW ||
          finding.status === FindingStatus.REOPENED),
    ).length;
    if (aiFresh > 0 && staticFresh === 0) {
      this.logger.warn('notification.pull_critical_found', {
        ...log,
        criticalCount: aiFresh,
        source: 'ai',
      });
    }
    await notifyIfAllCriticalResolved(
      this.prisma,
      this.redis,
      this.logger,
      {
        id: scanId,
        headSha: scan.headSha,
        criticalCount: persisted.criticalCount,
      },
      log,
    );
    this.logger.info('audit.ai.completed', {
      ...log,
      provider: aiProvider,
      model: aiModel,
      tokensIn: completion.usage.inputTokens,
      tokensOut: completion.usage.outputTokens,
      findings: rows.length,
      rejected: validation.rejected.length,
      deduped: duplicates.length,
      cached: false,
    });
  }

  // BullMQ emits `failed` after every attempt; only the last one settles
  // the scan's AI status.
  @OnWorkerEvent('failed')
  async onFailed(job: Job<AiJobPayload> | undefined, error: Error) {
    if (!job) {
      return;
    }
    const { scanId, organizationId, pullId } = job.data;
    const log: LogContext = { orgId: organizationId, pullId, scanId };
    const isFinal =
      error instanceof UnrecoverableError ||
      job.attemptsMade >= (job.opts.attempts ?? 1);
    if (!isFinal) {
      this.logger.warn('ai.attempt_failed', {
        ...log,
        code: error instanceof AiError ? error.code : error.name,
      });
      return;
    }

    const code =
      error instanceof AiJobFailure || error instanceof AiError
        ? error.code
        : // A code host failure while fetching the diff, or a bug.
          'diff_unavailable';
    try {
      await this.prisma.scan.updateMany({
        where: {
          id: scanId,
          aiStatus: { in: [AiScanStatus.QUEUED, AiScanStatus.RUNNING] },
        },
        data: {
          aiStatus: AiScanStatus.FAILED,
          aiErrorCode: code,
          aiFinishedAt: new Date(),
        },
      });
      this.logger.error('ai.failed', { ...log, code });
      await this.notifyResolvedIfDone(scanId, log);
      if (code === 'auth_failed') {
        await this.notifyAuthFailed(organizationId, log);
      }
    } catch {
      this.logger.error('ai.failed_finalize_error', log);
    }
  }

  // The AI step was this scan's last one, so it decides "all criticals
  // resolved" — also when it ends without a result.
  private async notifyResolvedIfDone(
    scanId: string,
    log: LogContext,
  ): Promise<void> {
    const scan = await this.prisma.scan.findUnique({
      where: { id: scanId },
      select: { headSha: true, criticalCount: true },
    });
    if (scan) {
      await notifyIfAllCriticalResolved(
        this.prisma,
        this.redis,
        this.logger,
        {
          id: scanId,
          headSha: scan.headSha,
          criticalCount: scan.criticalCount,
        },
        log,
      );
    }
  }

  // Head-file text per path, cached 60 s per (repo, sha, path) so a retry or
  // a regenerate right after does not refetch.
  private async headFileContents(
    organizationId: string,
    repositoryId: string,
    pullId: string,
    sha: string,
    paths: string[],
  ): Promise<Map<string, string | null>> {
    const keyOf = (path: string) =>
      `ai:file:${repositoryId}:${sha}:${createHash('sha1').update(path).digest('hex')}`;
    const contents = new Map<string, string | null>();
    const missing: string[] = [];
    for (const path of paths) {
      let cached: string | null = null;
      try {
        cached = await this.redis.get(keyOf(path));
      } catch {
        cached = null;
      }
      if (cached !== null) {
        contents.set(path, cached);
      } else {
        missing.push(path);
      }
    }
    if (missing.length === 0) {
      return contents;
    }
    const fetched = await this.pullsService.getHeadFileContents(
      organizationId,
      repositoryId,
      pullId,
      sha,
      missing,
    );
    for (const [path, content] of fetched) {
      contents.set(path, content);
      if (content !== null) {
        try {
          await this.redis.set(
            keyOf(path),
            content,
            'EX',
            HEAD_FILE_CACHE_SECONDS,
          );
        } catch {
          // cache is best effort
        }
      }
    }
    return contents;
  }

  // The raw answer of an invalid or truncated response, encrypted, 30 days —
  // only for debugging a provider/model that does not follow the tool schema
  // or runs out of output tokens. Never logged.
  private async keepRawResponse(
    scanId: string,
    error: AiError,
    log: LogContext,
  ): Promise<void> {
    const key = `ai:raw:${scanId}`;
    try {
      const raw = JSON.stringify(error.raw ?? null).slice(0, MAX_RAW_CHARS);
      await this.redis.set(
        key,
        this.encryptionService.encrypt(raw),
        'EX',
        RAW_RETENTION_SECONDS,
      );
      await this.prisma.scan.update({
        where: { id: scanId },
        data: { aiRawRef: key },
      });
    } catch {
      this.logger.warn('ai.raw_store_failed', log);
    }
  }

  private async notifyAuthFailed(
    organizationId: string,
    log: LogContext,
  ): Promise<void> {
    try {
      const first = await this.redis.set(
        `notify:ai-auth:${organizationId}`,
        '1',
        'EX',
        AUTH_NOTIFY_THROTTLE_SECONDS,
        'NX',
      );
      if (first !== 'OK') {
        return;
      }
    } catch {
      // notify anyway when Redis is unavailable
    }
    this.logger.warn('notification.ai_provider_auth_failed', log);
  }
}
