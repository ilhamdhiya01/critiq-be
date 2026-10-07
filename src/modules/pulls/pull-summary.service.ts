import { PARTIAL_RESPONSE } from '../ai/scan/ai-scan.persistence';
import {
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import { Logger } from 'winston';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RateLimiterService } from '../../common/redis/rate-limiter.service';
import { AiScanStatus, ScanStatus } from '../../generated/prisma/enums';
import { AiScanService } from '../ai/scan/ai-scan.service';
import { ScansService } from '../scans/scans.service';
import { toApiAiStatus } from '../scans/dto/ai-scan-fields';
import { PullSummaryDto } from './dto/pull-summary.dto';

const REGENERATE_WINDOW_SECONDS = 120;
const IN_FLIGHT: AiScanStatus[] = [AiScanStatus.QUEUED, AiScanStatus.RUNNING];
// Failures that regenerating cannot fix: the same request stops at the same
// output limit again. The default hint suggests regenerating.
const FAILED_HINTS: Record<string, string> = {
  reasoning_exhausted:
    'The AI model spent its whole output budget on reasoning before answering. Regenerating will fail the same way — split the pull request, or an Admin can choose another model in Settings → AI Provider.',
  output_truncated:
    'The AI answer was cut off at the output token limit. Regenerating will fail the same way — an Admin can choose another model in Settings → AI Provider.',
};

function kb(bytes: number): string {
  return `${Math.round(bytes / 1024)} KB`;
}

@Injectable()
export class PullSummaryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly aiScanService: AiScanService,
    private readonly scansService: ScansService,
    private readonly rateLimiter: RateLimiterService,
    private readonly configService: ConfigService,
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
  ) {}

  async getSummary(
    organizationId: string,
    repositoryId: string,
    pullId: string,
  ): Promise<PullSummaryDto> {
    const pull = await this.findPullOrThrow(
      organizationId,
      repositoryId,
      pullId,
    );
    const scan = pull.latestScan;
    if (!scan) {
      return new PullSummaryDto({
        scanId: null,
        aiStatus: null,
        summaryMd: null,
        riskLevel: null,
        reportedRiskLevel: null,
        partial: false,
        provider: null,
        model: null,
        generatedAt: null,
        cached: false,
        filesOmitted: [],
        tokens: null,
        error: {
          code: 'no_scan',
          hint: 'This pull request has not been scanned yet.',
        },
      });
    }
    const summary = scan.aiSummary;
    return new PullSummaryDto({
      scanId: scan.id,
      aiStatus: toApiAiStatus(scan.aiStatus),
      summaryMd: summary?.summaryMd ?? null,
      riskLevel: summary
        ? (summary.riskLevel.toLowerCase() as 'low' | 'medium' | 'high')
        : null,
      reportedRiskLevel:
        summary && scan.aiReportedRiskLevel
          ? (scan.aiReportedRiskLevel.toLowerCase() as
              'low' | 'medium' | 'high')
          : null,
      partial: scan.aiFlags.includes(PARTIAL_RESPONSE),
      provider: scan.aiProvider,
      model: scan.aiModel,
      generatedAt: summary?.createdAt ?? null,
      cached: scan.aiCached,
      filesOmitted: summary?.filesOmitted ?? [],
      tokens:
        scan.aiTokensIn !== null && scan.aiTokensOut !== null
          ? { in: scan.aiTokensIn, out: scan.aiTokensOut }
          : null,
      error: this.errorFor(scan),
    });
  }

  async regenerate(
    organizationId: string,
    repositoryId: string,
    pullId: string,
    actorUserId: string,
    force: boolean,
  ): Promise<{ scanId: string; aiStatus: string }> {
    // force (v1.5.1 langkah 3): a new FULL scan — static and AI — rather than
    // re-running the AI on the existing one. Rescan's own checks apply
    // (scan in progress, no head sha, rate limit).
    if (force) {
      this.logger.info('audit.ai.regenerate_requested', {
        orgId: organizationId,
        pullId,
        by: actorUserId,
        force,
      });
      const requested = await this.scansService.requestRescan(
        organizationId,
        repositoryId,
        pullId,
        actorUserId,
        true,
      );
      return { scanId: requested.scanId, aiStatus: 'queued' };
    }

    const pull = await this.findPullOrThrow(
      organizationId,
      repositoryId,
      pullId,
    );
    const scan = pull.latestScan;
    if (!scan || scan.status !== ScanStatus.DONE) {
      throw new HttpException(
        { field: 'pullId', message: 'scan_not_done' },
        HttpStatus.PRECONDITION_FAILED,
      );
    }
    if (scan.aiStatus && IN_FLIGHT.includes(scan.aiStatus)) {
      throw new ConflictException({
        field: 'pullId',
        message: 'ai_in_progress',
      });
    }
    const allowed = await this.rateLimiter.tryAcquire(
      `ratelimit:ai-regenerate:pull:${pullId}`,
      REGENERATE_WINDOW_SECONDS,
    );
    if (!allowed) {
      throw new HttpException(
        { field: 'pullId', message: 'regenerate_rate_limited' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // TODO(audit log model): persisted row once the table exists.
    this.logger.info('audit.ai.regenerate_requested', {
      orgId: organizationId,
      pullId,
      scanId: scan.id,
      by: actorUserId,
      force,
    });

    const status = await this.aiScanService.maybeEnqueue(scan.id);
    if (status === AiScanStatus.QUEUED || status === AiScanStatus.CACHED) {
      return { scanId: scan.id, aiStatus: toApiAiStatus(status)! };
    }
    // A prerequisite failed: the message is the resulting aiStatus
    // (consent_required, not_configured, …), which GET summary explains.
    throw new HttpException(
      { field: 'pullId', message: toApiAiStatus(status) ?? 'scan_not_done' },
      HttpStatus.PRECONDITION_FAILED,
    );
  }

  private errorFor(scan: {
    aiStatus: AiScanStatus | null;
    aiErrorCode: string | null;
    diffBytes: number | null;
  }): { code: string; hint: string } | null {
    switch (scan.aiStatus) {
      case AiScanStatus.NOT_CONFIGURED:
        return {
          code: 'not_configured',
          hint: 'No AI provider is configured. An Admin can set one up in Settings → AI Provider.',
        };
      case AiScanStatus.CONSENT_REQUIRED:
        return {
          code: 'consent_required',
          hint: 'Enable "Send diff content to the configured AI provider" in Settings → AI Provider.',
        };
      case AiScanStatus.SKIPPED_MANUAL_MODE:
        return {
          code: 'skipped_manual_mode',
          hint: 'The target branch policy is Manual only, so AI review does not run for this pull request.',
        };
      case AiScanStatus.SKIPPED_TOO_LARGE:
        return {
          code: 'skipped_too_large',
          hint: `The diff is too large for AI review: ${kb(scan.diffBytes ?? 0)} > ${kb(this.configService.getOrThrow<number>('ai.maxDiffBytes'))}.`,
        };
      case AiScanStatus.BUDGET_EXCEEDED:
        return {
          code: 'budget_exceeded',
          hint: "The organization's daily AI token budget is used up. It resets at 00:00 UTC.",
        };
      case AiScanStatus.FAILED:
        return {
          code: scan.aiErrorCode ?? 'failed',
          hint:
            FAILED_HINTS[scan.aiErrorCode ?? ''] ??
            `AI review failed (${scan.aiErrorCode ?? 'unknown'}). An Admin or Reviewer can regenerate it.`,
        };
      default:
        return null;
    }
  }

  // Check-after-fetch: another org's or repo's PR is indistinguishable from
  // a missing one.
  private async findPullOrThrow(
    organizationId: string,
    repositoryId: string,
    pullId: string,
  ) {
    const pull = await this.prisma.pullRequest.findUnique({
      where: { id: pullId },
      include: { latestScan: { include: { aiSummary: true } } },
    });
    if (
      !pull ||
      pull.organizationId !== organizationId ||
      pull.repositoryId !== repositoryId
    ) {
      throw new NotFoundException('Pull request not found.');
    }
    return pull;
  }
}
