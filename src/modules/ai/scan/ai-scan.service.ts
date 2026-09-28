import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { createHash } from 'crypto';
import type Redis from 'ioredis';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import { Logger } from 'winston';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { REDIS_CLIENT } from '../../../common/redis/redis.constants';
import {
  AiProviderId,
  AiScanStatus,
  AiUsageKind,
  FindingSource,
  ReviewPolicy,
  ScanStatus,
} from '../../../generated/prisma/enums';
import {
  AI_JOB_ATTEMPTS,
  AI_QUEUE_NAME,
  AiJobPayload,
  buildAiJobId,
} from '../../../queue/ai-queue.constants';
import { defaultModelFor, toProviderName } from '../ai-models.constants';
import { AiProviderName } from '../ai-provider.interface';
import { dedupeAiFindings } from './ai-deduper';
import { CHARS_PER_TOKEN } from './ai-prompt-builder';
import { AI_PROMPT_VERSION } from './ai-prompt.constants';
import { persistAiResult } from './ai-scan.persistence';

const CACHE_TTL_SECONDS = 30 * 86_400;
const BUDGET_NOTIFY_TTL_SECONDS = 26 * 3600;

const IN_FLIGHT: AiScanStatus[] = [AiScanStatus.QUEUED, AiScanStatus.RUNNING];
// Prisma's notIn never matches NULL, so "no AI status yet" is spelled out.
const NOT_IN_FLIGHT = {
  OR: [{ aiStatus: null }, { aiStatus: { notIn: IN_FLIGHT } }],
};

export interface AiCacheKeyParts {
  repositoryId: string;
  headSha: string;
  rulesetVersion: string;
  promptVersion: string;
  provider: AiProviderName;
  model: string;
}

export function aiCacheKey(parts: AiCacheKeyParts): string {
  const digest = createHash('sha256')
    .update(
      [
        parts.repositoryId,
        parts.headSha,
        parts.rulesetVersion,
        parts.promptVersion,
        parts.provider,
        parts.model,
      ].join('|'),
    )
    .digest('hex');
  return `ai:cache:${digest}`;
}

export function todayUtc(): Date {
  return new Date(new Date().toISOString().slice(0, 10));
}

// Decides whether a finished static scan gets an AI review, and starts it.
// The first failing prerequisite is recorded on scans.aiStatus — that is
// what GET …/summary explains to the user.
@Injectable()
export class AiScanService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    @InjectQueue(AI_QUEUE_NAME) private readonly aiQueue: Queue<AiJobPayload>,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
  ) {}

  // Returns the resulting aiStatus, or null when the scan is not DONE (the
  // AI step never applies to a failed or superseded static scan).
  async maybeEnqueue(
    scanId: string,
    options: { force?: boolean } = {},
  ): Promise<AiScanStatus | null> {
    const scan = await this.prisma.scan.findUnique({
      where: { id: scanId },
      include: {
        pullRequest: { select: { effectivePolicy: true } },
        organization: {
          select: {
            aiProvider: true,
            aiModel: true,
            aiConsentAt: true,
            aiDailyTokenBudget: true,
          },
        },
      },
    });
    if (!scan || scan.status !== ScanStatus.DONE) {
      return null;
    }
    const log = { orgId: scan.organizationId, scanId };
    const settle = (status: AiScanStatus) => this.setStatus(scanId, status);

    // 1. Branch policy (the only "mode" before v1.5.2's per-PR mode).
    if (scan.pullRequest.effectivePolicy === ReviewPolicy.MANUAL_ONLY) {
      return settle(AiScanStatus.SKIPPED_MANUAL_MODE);
    }

    // 2. Provider + credential, without decrypting anything.
    const { organization } = scan;
    const providerId = organization.aiProvider;
    const credential = providerId
      ? await this.prisma.aiCredential.findUnique({
          where: {
            organizationId_provider: {
              organizationId: scan.organizationId,
              provider: providerId,
            },
          },
          select: { encryptedKey: true, baseUrl: true },
        })
      : null;
    const configured =
      providerId === AiProviderId.OPENAI_COMPATIBLE
        ? Boolean(credential?.baseUrl)
        : Boolean(credential?.encryptedKey);
    if (!providerId || !configured) {
      return settle(AiScanStatus.NOT_CONFIGURED);
    }
    const provider = toProviderName(providerId);
    const model = organization.aiModel ?? defaultModelFor(provider);
    if (!model) {
      return settle(AiScanStatus.NOT_CONFIGURED);
    }

    // 3. Consent.
    if (!organization.aiConsentAt) {
      return settle(AiScanStatus.CONSENT_REQUIRED);
    }

    // 4. Size — the scannable patch bytes the static scan measured.
    const diffBytes = scan.diffBytes ?? 0;
    if (diffBytes > this.configService.getOrThrow<number>('ai.maxDiffBytes')) {
      return settle(AiScanStatus.SKIPPED_TOO_LARGE);
    }

    // 5. Daily budget (TEST usage never counts).
    const estimate = Math.ceil(diffBytes / CHARS_PER_TOKEN);
    const used = await this.usedTokensToday(scan.organizationId);
    if (organization.aiDailyTokenBudget - used < estimate) {
      await this.notifyBudgetExceeded(scan.organizationId, log);
      return settle(AiScanStatus.BUDGET_EXCEEDED);
    }

    // 6. Cache.
    const cacheKey = aiCacheKey({
      repositoryId: scan.repositoryId,
      headSha: scan.headSha,
      rulesetVersion: scan.rulesetVersion,
      promptVersion: AI_PROMPT_VERSION,
      provider,
      model,
    });
    if (!options.force) {
      const cached = await this.copyFromCache(scan, cacheKey);
      if (cached) {
        this.logger.info('audit.ai.completed', {
          ...log,
          provider,
          model,
          cached: true,
        });
        return AiScanStatus.CACHED;
      }
    }

    // 7. Enqueue — at most one run per scan: the transition to QUEUED is
    // conditional on no run being in flight.
    const claimed = await this.prisma.scan.updateMany({
      where: { id: scanId, ...NOT_IN_FLIGHT },
      data: {
        aiStatus: AiScanStatus.QUEUED,
        aiErrorCode: null,
        aiProvider: provider,
        aiModel: model,
        aiPromptVersion: AI_PROMPT_VERSION,
      },
    });
    if (claimed.count === 0) {
      return AiScanStatus.QUEUED;
    }
    try {
      await this.aiQueue.add(
        'ai',
        { scanId, organizationId: scan.organizationId, pullId: scan.pullId },
        {
          jobId: buildAiJobId(scanId, Date.now()),
          attempts: AI_JOB_ATTEMPTS,
          backoff: { type: 'ai' },
          removeOnComplete: { age: 86_400, count: 1000 },
          removeOnFail: { age: 7 * 86_400 },
        },
      );
    } catch (error) {
      await this.prisma.scan.update({
        where: { id: scanId },
        data: {
          aiStatus: AiScanStatus.FAILED,
          aiErrorCode: 'queue_unavailable',
          aiFinishedAt: new Date(),
        },
      });
      throw error;
    }
    this.logger.info('ai.enqueued', { ...log, provider, model });
    return AiScanStatus.QUEUED;
  }

  // Called by the processor after a successful run.
  async rememberInCache(parts: AiCacheKeyParts, scanId: string): Promise<void> {
    await this.redis.set(aiCacheKey(parts), scanId, 'EX', CACHE_TTL_SECONDS);
  }

  async recordUsage(
    organizationId: string,
    usage: { inputTokens: number; outputTokens: number },
  ): Promise<void> {
    const day = todayUtc();
    await this.prisma.aiUsageDaily.upsert({
      where: {
        organizationId_day_kind: {
          organizationId,
          day,
          kind: AiUsageKind.SCAN,
        },
      },
      create: {
        organizationId,
        day,
        kind: AiUsageKind.SCAN,
        calls: 1,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      },
      update: {
        calls: { increment: 1 },
        inputTokens: { increment: usage.inputTokens },
        outputTokens: { increment: usage.outputTokens },
      },
    });
  }

  private async setStatus(
    scanId: string,
    status: AiScanStatus,
  ): Promise<AiScanStatus> {
    // Never clobber a run in flight (e.g. a regenerate racing a rescan).
    await this.prisma.scan.updateMany({
      where: { id: scanId, ...NOT_IN_FLIGHT },
      data: { aiStatus: status, aiFinishedAt: new Date() },
    });
    return status;
  }

  private async usedTokensToday(organizationId: string): Promise<number> {
    const row = await this.prisma.aiUsageDaily.findUnique({
      where: {
        organizationId_day_kind: {
          organizationId,
          day: todayUtc(),
          kind: AiUsageKind.SCAN,
        },
      },
    });
    return row ? row.inputTokens + row.outputTokens : 0;
  }

  // Log stand-in for the notifications module, once per org per UTC day.
  private async notifyBudgetExceeded(
    organizationId: string,
    log: Record<string, unknown>,
  ): Promise<void> {
    const day = todayUtc().toISOString().slice(0, 10);
    try {
      const first = await this.redis.set(
        `notify:ai-budget:${organizationId}:${day}`,
        '1',
        'EX',
        BUDGET_NOTIFY_TTL_SECONDS,
        'NX',
      );
      if (first === 'OK') {
        this.logger.warn('notification.ai_budget_exceeded', log);
      }
    } catch {
      this.logger.warn('notification.ai_budget_exceeded', log);
    }
  }

  // A previous AI result for the same diff, provider, model, prompt and
  // ruleset — copied onto this scan and deduped again against this scan's
  // own static findings. No provider call.
  private async copyFromCache(
    scan: {
      id: string;
      organizationId: string;
      pullId: string;
      findingsCount: number;
    },
    cacheKey: string,
  ): Promise<boolean> {
    let sourceScanId: string | null;
    try {
      sourceScanId = await this.redis.get(cacheKey);
    } catch {
      return false;
    }
    if (!sourceScanId || sourceScanId === scan.id) {
      return false;
    }
    const source = await this.prisma.scan.findUnique({
      where: { id: sourceScanId },
      include: {
        aiSummary: true,
        findings: {
          where: { source: FindingSource.AI, suppressedReason: null },
        },
      },
    });
    if (
      !source?.aiSummary ||
      source.organizationId !== scan.organizationId ||
      (source.aiStatus !== AiScanStatus.DONE &&
        source.aiStatus !== AiScanStatus.CACHED)
    ) {
      return false;
    }

    const staticActive = await this.prisma.finding.findMany({
      where: {
        scanId: scan.id,
        source: FindingSource.STATIC,
        suppressedReason: null,
      },
      select: {
        id: true,
        filePath: true,
        lineStart: true,
        lineEnd: true,
        category: true,
      },
    });
    const drafts = source.findings.map((finding) => ({
      filePath: finding.filePath,
      lineStart: finding.lineStart,
      lineEnd: finding.lineEnd,
      category: finding.category!,
      severity: finding.severity,
      title: finding.title,
      message: finding.message,
      confidence: Number(finding.confidence ?? 0),
    }));
    const { kept, duplicates } = dedupeAiFindings(drafts, staticActive);

    return this.prisma.$transaction((tx) =>
      persistAiResult(
        tx,
        scan,
        {
          status: AiScanStatus.CACHED,
          summaryMd: source.aiSummary!.summaryMd,
          riskLevel: source.aiSummary!.riskLevel,
          filesOmitted: source.aiSummary!.filesOmitted,
          kept,
          duplicates,
          keepDeduped:
            this.configService.get<boolean>('ai.keepDeduped') ?? false,
          total: drafts.length,
          rejected: 0,
          provider: source.aiProvider ?? '',
          model: source.aiModel ?? '',
          promptVersion: source.aiPromptVersion ?? AI_PROMPT_VERSION,
          tokensIn: null,
          tokensOut: null,
        },
        // Any settled state (or none yet) may take a cached copy; a run in
        // flight may not be overwritten.
        NOT_IN_FLIGHT,
      ),
    );
  }
}
