import { InjectQueue } from '@nestjs/bullmq';
import {
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Queue } from 'bullmq';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import { Logger } from 'winston';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RateLimiterService } from '../../common/redis/rate-limiter.service';
import { Scan } from '../../generated/prisma/client';
import {
  FindingSeverity,
  FindingSource,
  FindingStatus,
  ScanStatus,
  ScanTrigger,
} from '../../generated/prisma/enums';
import { ScanJobPayload } from '../../queue/scan-payload.dto';
import {
  buildScanJobId,
  SCAN_QUEUE_NAME,
  ScanQueueService,
} from '../../queue/scan-queue.service';
import {
  ApiSuppressionReason,
  FindingDto,
  toApiSuppressionReason,
} from './dto/finding.dto';
import { toApiAiScanFields } from './dto/ai-scan-fields';
import {
  toApiFindingStatus,
  toApiLifecycleFields,
} from './dto/lifecycle-fields';

const ACTIVE_STATUSES: FindingStatus[] = [
  FindingStatus.NEW,
  FindingStatus.PERSISTED,
  FindingStatus.REOPENED,
];
const STATUS_RANK: Record<FindingStatus, number> = {
  [FindingStatus.REOPENED]: 0,
  [FindingStatus.NEW]: 1,
  [FindingStatus.PERSISTED]: 2,
  [FindingStatus.RESOLVED]: 3,
};
import { RepositoryScanDto } from './dto/repository-scan.dto';
import { ScanFindingsDto } from './dto/scan-findings.dto';
import {
  ActiveScanDto,
  ScanDto,
  ScanProgress,
  ScanRequestedDto,
  ScanStatusDto,
} from './dto/scan.dto';

const SCAN_HISTORY_LIMIT = 20;
const RESCAN_WINDOW_SECONDS = 30;
// How far into the waiting list queuePosition looks. Past this the FE just
// shows "queued" — scanning an unbounded list on every poll is not worth it.
const QUEUE_POSITION_SCAN_LIMIT = 1000;

const IN_FLIGHT: ScanStatus[] = [ScanStatus.QUEUED, ScanStatus.RUNNING];

@Injectable()
export class ScansService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scanQueueService: ScanQueueService,
    private readonly rateLimiter: RateLimiterService,
    @InjectQueue(SCAN_QUEUE_NAME)
    private readonly scanQueue: Queue<ScanJobPayload>,
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
  ) {}

  // The PR's scan history, newest first — every attempt, SUPERSEDED and
  // FAILED included, unlike latestScan which only ever points at a result.
  async listForPull(
    organizationId: string,
    repositoryId: string,
    pullId: string,
  ): Promise<ScanDto[]> {
    await this.findPullOrThrow(organizationId, repositoryId, pullId);
    const scans = await this.prisma.scan.findMany({
      where: { pullId },
      orderBy: { createdAt: 'desc' },
      take: SCAN_HISTORY_LIMIT,
    });
    return scans.map((scan) => this.toScanDto(scan));
  }

  // A repository's scan history across its PRs, newest first — every
  // attempt, like listForPull. Check-after-fetch: another org's repository
  // is indistinguishable from a missing one.
  async listForRepository(
    organizationId: string,
    repositoryId: string,
    limit = SCAN_HISTORY_LIMIT,
  ): Promise<RepositoryScanDto[]> {
    const repository = await this.prisma.repository.findUnique({
      where: { id: repositoryId },
      select: { organizationId: true },
    });
    if (!repository || repository.organizationId !== organizationId) {
      throw new NotFoundException('Repository not found.');
    }
    const scans = await this.prisma.scan.findMany({
      where: { organizationId, repositoryId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        pullRequest: { select: { id: true, externalId: true, title: true } },
      },
    });
    return scans.map(
      ({ pullRequest, ...scan }) =>
        new RepositoryScanDto({
          ...this.toScanDto(scan),
          pull: {
            id: pullRequest.id,
            number: pullRequest.externalId,
            title: pullRequest.title,
          },
        }),
    );
  }

  // Manual rescan (Admin/Reviewer). Always a new attempt on the PR's current
  // head sha — unlike a webhook, a person asking again is never a duplicate.
  // Incremental by default (only what changed since the last finished scan,
  // often nothing); `full` rescans the whole PR (v1.5.1 langkah 3).
  async requestRescan(
    organizationId: string,
    repositoryId: string,
    pullId: string,
    actorUserId: string,
    full = false,
  ): Promise<ScanRequestedDto> {
    const pull = await this.findPullOrThrow(
      organizationId,
      repositoryId,
      pullId,
    );
    if (!pull.headSha) {
      throw new ConflictException({ field: 'pullId', message: 'no_head_sha' });
    }

    // Checked before the rate limiter so a refused request doesn't burn the
    // caller's slot. Two requests racing past this check are still caught
    // by the limiter below: only one gets the slot.
    const inFlight = await this.prisma.scan.findFirst({
      where: { pullId, status: { in: IN_FLIGHT } },
      select: { id: true },
    });
    if (inFlight) {
      throw new ConflictException({
        field: 'pullId',
        message: 'scan_in_progress',
      });
    }

    const allowed = await this.rateLimiter.tryAcquire(
      `ratelimit:rescan:pull:${pullId}`,
      RESCAN_WINDOW_SECONDS,
    );
    if (!allowed) {
      throw new HttpException(
        { field: 'pullId', message: 'rescan_rate_limited' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const result = await this.scanQueueService.enqueue({
      organizationId,
      repositoryId,
      pullId,
      headSha: pull.headSha,
      // Informational only; the processor diffs against the provider's
      // merge base (same as ReposService.rescanOpenPulls).
      baseSha: null,
      provider: pull.provider,
      trigger: ScanTrigger.RESCAN,
      full,
    });

    // TODO(audit log model): persisted AuditLog row once the table exists —
    // a structured log line until then, like every other audit.* event.
    this.logger.info('audit.scan_requested', {
      orgId: organizationId,
      repoId: repositoryId,
      pullId,
      scanId: result.scanId,
      actorUserId,
      full,
    });
    return new ScanRequestedDto({
      scanId: result.scanId,
      status: result.status,
    });
  }

  async getScan(
    organizationId: string,
    scanId: string,
  ): Promise<ScanStatusDto> {
    const scan = await this.findScanOrThrow(organizationId, scanId);
    const inFlight = IN_FLIGHT.includes(scan.status);
    const [progress, queuePosition] = await Promise.all([
      inFlight ? this.readProgress(scan.id) : null,
      scan.status === ScanStatus.QUEUED
        ? this.readQueuePosition(scan.id)
        : null,
    ]);
    return new ScanStatusDto({
      ...this.toScanDto(scan),
      progress,
      queuePosition,
    });
  }

  async listFindings(
    organizationId: string,
    scanId: string,
    includeSuppressed: boolean,
    statusFilter: 'active' | 'resolved' | 'all' = 'active',
  ): Promise<ScanFindingsDto> {
    const scan = await this.findScanOrThrow(organizationId, scanId);

    const statusWhere =
      statusFilter === 'active'
        ? { status: { in: ACTIVE_STATUSES } }
        : statusFilter === 'resolved'
          ? { status: FindingStatus.RESOLVED }
          : {};
    const [findings, suppressedGroups, statusGroups] = await Promise.all([
      this.prisma.finding.findMany({
        where: {
          scanId,
          ...statusWhere,
          ...(includeSuppressed ? {} : { suppressedReason: null }),
        },
        // Severity is ordered CRITICAL → INFO in the enum, so ascending puts
        // criticals first.
        orderBy: [
          { severity: 'asc' },
          { filePath: 'asc' },
          { lineStart: 'asc' },
        ],
      }),
      // Grouped in the DB rather than from `findings`, so the breakdown is
      // there even when ?includeSuppressed=false left those rows out.
      this.prisma.finding.groupBy({
        by: ['suppressedReason'],
        where: {
          scanId,
          suppressedReason: { not: null },
          status: { not: FindingStatus.RESOLVED },
        },
        _count: { _all: true },
      }),
      this.prisma.finding.groupBy({
        by: ['status'],
        where: { scanId, suppressedReason: null },
        _count: { _all: true },
      }),
    ]);

    // Not suppressed first, then suppressed; within each, reopened → new →
    // persisted → resolved (stable, so the DB's severity/file/line order
    // holds inside a status).
    const byStatusRank = (
      a: { status: FindingStatus },
      b: { status: FindingStatus },
    ) => STATUS_RANK[a.status] - STATUS_RANK[b.status];
    const active = findings
      .filter((f) => f.suppressedReason === null)
      .sort(byStatusRank);
    const suppressed = findings
      .filter((f) => f.suppressedReason !== null)
      .sort(byStatusRank);

    const byFile: Record<string, number> = {};
    const bySource = { static: 0, ai: 0 };
    const bySeverity = { critical: 0, major: 0, minor: 0 };
    const byStatus = { new: 0, persisted: 0, reopened: 0, resolved: 0 };
    for (const group of statusGroups) {
      byStatus[toApiFindingStatus(group.status)] = group._count._all;
    }
    for (const finding of active) {
      if (finding.status === FindingStatus.RESOLVED) {
        continue; // counts describe what is live, not history
      }
      byFile[finding.filePath] = (byFile[finding.filePath] ?? 0) + 1;
      bySource[finding.source === FindingSource.AI ? 'ai' : 'static'] += 1;
      if (finding.severity === FindingSeverity.CRITICAL)
        bySeverity.critical += 1;
      else if (finding.severity === FindingSeverity.MAJOR)
        bySeverity.major += 1;
      else if (finding.severity === FindingSeverity.MINOR)
        bySeverity.minor += 1;
    }

    const suppressedByReason: Record<ApiSuppressionReason, number> = {
      test_file: 0,
      comment: 0,
      regex_literal: 0,
      dedupe_static: 0,
    };
    for (const group of suppressedGroups) {
      const reason = toApiSuppressionReason(group.suppressedReason);
      if (reason) {
        suppressedByReason[reason] = group._count._all;
      }
    }

    return new ScanFindingsDto({
      scanId,
      items: [...active, ...suppressed].map(
        (finding) =>
          new FindingDto({
            id: finding.id,
            source: finding.source,
            ruleId: finding.ruleId,
            severity: finding.severity,
            title: finding.title,
            message: finding.message,
            filePath: finding.filePath,
            lineStart: finding.lineStart,
            lineEnd: finding.lineEnd,
            snippet: finding.snippet,
            suppressedReason: finding.suppressedReason,
            category: finding.category,
            confidence: finding.confidence,
            reportedSeverity: finding.reportedSeverity,
            previousRunSeverity: finding.previousRunSeverity,
            latestRunSeverity: finding.latestRunSeverity,
            notReproduced: finding.notReproduced,
            status: finding.status,
            firstSeenScanId: finding.firstSeenScanId,
            originFindingId: finding.originFindingId,
            resolvedInScanId: finding.resolvedInScanId,
          }),
      ),
      byFile,
      bySource,
      bySeverity,
      byStatus,
      aiDroppedLowConfidence: scan.aiFindingsDropped,
      criticalCount: scan.criticalCount,
      suppressedCount: scan.suppressedCount,
      suppressedByReason,
      findingsTruncated: scan.findingsTruncated,
      suppressedTruncated: scan.suppressedTruncated,
    });
  }

  // In-flight scan per PR, for list views: one query for all rows, then one
  // Redis read per in-flight scan (usually a handful), never one per PR.
  // Callers pass PR ids they already scoped to the organization.
  async findActiveScans(
    pullIds: string[],
  ): Promise<Map<string, ActiveScanDto>> {
    const active = new Map<string, ActiveScanDto>();
    if (pullIds.length === 0) {
      return active;
    }
    const scans = await this.prisma.scan.findMany({
      where: { pullId: { in: pullIds }, status: { in: IN_FLIGHT } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, pullId: true, status: true },
    });
    // cancelPending keeps this at one per PR; newest wins if it ever isn't
    // (rows are newest first, so the first one seen per PR is kept).
    const byPull = new Map<string, (typeof scans)[number]>();
    for (const scan of scans) {
      if (!byPull.has(scan.pullId)) {
        byPull.set(scan.pullId, scan);
      }
    }
    const newestPerPull = [...byPull.values()];
    const progress = await Promise.all(
      newestPerPull.map((scan) => this.readProgress(scan.id)),
    );
    newestPerPull.forEach((scan, index) => {
      active.set(
        scan.pullId,
        new ActiveScanDto({
          id: scan.id,
          status: scan.status,
          progress: progress[index],
        }),
      );
    });
    return active;
  }

  private toScanDto(scan: Scan): ScanDto {
    return new ScanDto({
      id: scan.id,
      pullId: scan.pullId,
      status: scan.status,
      trigger: scan.trigger,
      attempt: scan.attempt,
      headSha: scan.headSha,
      findingsCount: scan.findingsCount,
      criticalCount: scan.criticalCount,
      findingsTruncated: scan.findingsTruncated,
      suppressedCount: scan.suppressedCount,
      suppressedTruncated: scan.suppressedTruncated,
      filesChanged: scan.filesChanged,
      diffBytes: scan.diffBytes,
      rulesetVersion: scan.rulesetVersion,
      errorCode: scan.errorCode,
      errorMessage: scan.errorMessage,
      createdAt: scan.createdAt,
      startedAt: scan.startedAt,
      finishedAt: scan.finishedAt,
      ...toApiAiScanFields(scan),
      ...toApiLifecycleFields(scan),
    });
  }

  // Redis reads are best-effort decoration on a DB-backed answer: if the
  // queue is unreachable the endpoint still returns the scan's status.
  private async readProgress(scanId: string): Promise<ScanProgress | null> {
    try {
      const job = await this.scanQueue.getJob(buildScanJobId(scanId));
      const progress: unknown = job?.progress;
      if (
        typeof progress === 'object' &&
        progress !== null &&
        typeof (progress as ScanProgress).step === 'string' &&
        typeof (progress as ScanProgress).pct === 'number'
      ) {
        const { step, pct } = progress as ScanProgress;
        return { step, pct };
      }
      return null;
    } catch (error) {
      this.warnQueueUnavailable(scanId, error);
      return null;
    }
  }

  private async readQueuePosition(scanId: string): Promise<number | null> {
    try {
      // Oldest first, ids only — no job data is loaded.
      const waiting = await this.scanQueue.getRanges(
        ['waiting'],
        0,
        QUEUE_POSITION_SCAN_LIMIT - 1,
        true,
      );
      const index = waiting.indexOf(buildScanJobId(scanId));
      return index >= 0 ? index + 1 : null;
    } catch (error) {
      this.warnQueueUnavailable(scanId, error);
      return null;
    }
  }

  private warnQueueUnavailable(scanId: string, error: unknown): void {
    this.logger.warn('scan.queue_unavailable', {
      scanId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // Check-after-fetch, not a scoped `where`: a PR in another org or repo is
  // indistinguishable from one that doesn't exist (D5 — never leak
  // existence).
  private async findPullOrThrow(
    organizationId: string,
    repositoryId: string,
    pullId: string,
  ) {
    const pull = await this.prisma.pullRequest.findUnique({
      where: { id: pullId },
      select: {
        id: true,
        organizationId: true,
        repositoryId: true,
        headSha: true,
        provider: true,
      },
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

  private async findScanOrThrow(
    organizationId: string,
    scanId: string,
  ): Promise<Scan> {
    const scan = await this.prisma.scan.findUnique({ where: { id: scanId } });
    if (!scan || scan.organizationId !== organizationId) {
      throw new NotFoundException('Scan not found.');
    }
    return scan;
  }
}
