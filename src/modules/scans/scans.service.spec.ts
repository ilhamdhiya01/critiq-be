import { HttpStatus } from '@nestjs/common';
import { Queue } from 'bullmq';
import { Logger } from 'winston';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RateLimiterService } from '../../common/redis/rate-limiter.service';
import {
  FindingSeverity,
  FindingSource,
  Provider,
  ScanStatus,
  ScanTrigger,
  SuppressionReason,
} from '../../generated/prisma/enums';
import { ScanJobPayload } from '../../queue/scan-payload.dto';
import { ScanQueueService } from '../../queue/scan-queue.service';
import { ScansService } from './scans.service';

// ESM-only packages this CommonJS Jest setup cannot load (see
// webhooks.service.spec.ts). Every collaborator is a stub below.
jest.mock('@nestjs/bullmq', () => ({ InjectQueue: () => () => undefined }));
jest.mock('bullmq', () => ({ Queue: class {} }));
jest.mock('../../common/prisma/prisma.service', () => ({
  PrismaService: class {},
}));
jest.mock('../../common/redis/rate-limiter.service', () => ({
  RateLimiterService: class {},
}));
jest.mock('../../queue/scan-queue.service', () => ({
  ScanQueueService: class {},
  SCAN_QUEUE_NAME: 'scan',
  buildScanJobId: (scanId: string) => `scan-${scanId}`,
}));

const ORG = 'org_1';
const REPO = 'repo_1';

const pull = {
  id: 'pull_1',
  organizationId: ORG,
  repositoryId: REPO,
  headSha: 'abc123',
  provider: Provider.GITHUB,
};

const scan = {
  id: 'scan_1',
  organizationId: ORG,
  repositoryId: REPO,
  pullId: 'pull_1',
  headSha: 'abc123',
  baseSha: null,
  status: ScanStatus.DONE,
  trigger: ScanTrigger.WEBHOOK,
  attempt: 1,
  errorCode: null,
  errorMessage: null,
  diffBytes: 1200,
  filesChanged: 3,
  findingsCount: 1,
  criticalCount: 1,
  rulesetVersion: '2026.09.4',
  findingsTruncated: false,
  suppressedCount: 2,
  suppressedTruncated: false,
  startedAt: new Date('2026-09-28T01:00:00Z'),
  finishedAt: new Date('2026-09-28T01:00:05Z'),
  createdAt: new Date('2026-09-28T00:59:59Z'),
};

function finding(
  id: string,
  filePath: string,
  lineStart: number,
  suppressedReason: SuppressionReason | null,
) {
  return {
    id,
    organizationId: ORG,
    scanId: scan.id,
    source: FindingSource.STATIC,
    ruleId: 'secret.db_url_with_password',
    severity: FindingSeverity.CRITICAL,
    title: 'Database URL with password',
    message: 'Move it to an environment variable.',
    filePath,
    lineStart,
    lineEnd: lineStart,
    snippet: null,
    fingerprint: `fp_${id}`,
    suppressedReason,
    createdAt: new Date(),
  };
}

function setup() {
  const prisma = {
    pullRequest: { findUnique: jest.fn().mockResolvedValue(pull) },
    scan: {
      findUnique: jest.fn().mockResolvedValue(scan),
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
    },
    finding: {
      findMany: jest.fn().mockResolvedValue([]),
      groupBy: jest.fn().mockResolvedValue([]),
    },
  };
  const scanQueueService = {
    enqueue: jest.fn().mockResolvedValue({
      scanId: 'scan_2',
      status: ScanStatus.QUEUED,
      deduplicated: false,
    }),
  };
  const rateLimiter = { tryAcquire: jest.fn().mockResolvedValue(true) };
  const queue = {
    getJob: jest.fn().mockResolvedValue(null),
    getRanges: jest.fn().mockResolvedValue([]),
  };
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

  const service = new ScansService(
    prisma as unknown as PrismaService,
    scanQueueService as unknown as ScanQueueService,
    rateLimiter as unknown as RateLimiterService,
    queue as unknown as Queue<ScanJobPayload>,
    logger as unknown as Logger,
  );
  return { service, prisma, scanQueueService, rateLimiter, queue, logger };
}

describe('ScansService', () => {
  describe('tenancy', () => {
    it('404s a scan from another organization, same as a missing one', async () => {
      const { service, prisma } = setup();
      prisma.scan.findUnique.mockResolvedValue({
        ...scan,
        organizationId: 'org_other',
      });
      await expect(service.getScan(ORG, scan.id)).rejects.toMatchObject({
        status: HttpStatus.NOT_FOUND,
      });
      await expect(
        service.listFindings(ORG, scan.id, true),
      ).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND });

      prisma.scan.findUnique.mockResolvedValue(null);
      await expect(service.getScan(ORG, scan.id)).rejects.toMatchObject({
        status: HttpStatus.NOT_FOUND,
      });
    });

    it('404s a PR that belongs to another repo in the same org', async () => {
      const { service, prisma, scanQueueService } = setup();
      prisma.pullRequest.findUnique.mockResolvedValue({
        ...pull,
        repositoryId: 'repo_other',
      });
      await expect(
        service.requestRescan(ORG, REPO, pull.id, 'user_1'),
      ).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND });
      await expect(
        service.listForPull(ORG, REPO, pull.id),
      ).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND });
      expect(scanQueueService.enqueue).not.toHaveBeenCalled();
    });
  });

  describe('listFindings', () => {
    const rows = [
      finding('f_spec', 'src/auth.spec.ts', 3, SuppressionReason.TEST_FILE),
      finding('f_active', 'src/config.ts', 9, null),
      finding('f_regex', 'src/lint.ts', 1, SuppressionReason.REGEX_LITERAL),
    ];
    const groups = [
      { suppressedReason: SuppressionReason.TEST_FILE, _count: { _all: 1 } },
      {
        suppressedReason: SuppressionReason.REGEX_LITERAL,
        _count: { _all: 1 },
      },
    ];

    it('lists active first, then suppressed, with lowercase reasons', async () => {
      const { service, prisma } = setup();
      prisma.finding.findMany.mockResolvedValue(rows);
      prisma.finding.groupBy.mockResolvedValue(groups);

      const result = await service.listFindings(ORG, scan.id, true);

      expect(result.items.map((item) => item.id)).toEqual([
        'f_active',
        'f_spec',
        'f_regex',
      ]);
      expect(result.items.map((item) => item.suppressedReason)).toEqual([
        null,
        'test_file',
        'regex_literal',
      ]);
      expect(result.byFile).toEqual({ 'src/config.ts': 1 });
      expect(result.criticalCount).toBe(1);
      expect(result.suppressedCount).toBe(2);
      expect(result.suppressedByReason).toEqual({
        test_file: 1,
        comment: 0,
        regex_literal: 1,
        dedupe_static: 0,
      });
    });

    // Acceptance 13.
    it('leaves suppressed rows out with includeSuppressed=false but keeps the counts', async () => {
      const { service, prisma } = setup();
      prisma.finding.findMany.mockResolvedValue([rows[1]]);
      prisma.finding.groupBy.mockResolvedValue(groups);

      const result = await service.listFindings(ORG, scan.id, false);

      expect(prisma.finding.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { scanId: scan.id, suppressedReason: null },
        }),
      );
      expect(result.items.map((item) => item.id)).toEqual(['f_active']);
      expect(result.suppressedCount).toBe(2);
      expect(result.suppressedByReason).toEqual({
        test_file: 1,
        comment: 0,
        regex_literal: 1,
        dedupe_static: 0,
      });
    });
  });

  describe('requestRescan', () => {
    it('enqueues a RESCAN on the head sha and returns it', async () => {
      const { service, scanQueueService, rateLimiter, logger } = setup();

      const result = await service.requestRescan(ORG, REPO, pull.id, 'user_1');

      expect(result).toEqual({ scanId: 'scan_2', status: ScanStatus.QUEUED });
      expect(rateLimiter.tryAcquire).toHaveBeenCalledWith(
        'ratelimit:rescan:pull:pull_1',
        30,
      );
      expect(scanQueueService.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: ORG,
          pullId: pull.id,
          headSha: 'abc123',
          trigger: ScanTrigger.RESCAN,
        }),
      );
      expect(logger.info).toHaveBeenCalledWith(
        'audit.scan_requested',
        expect.objectContaining({ scanId: 'scan_2', actorUserId: 'user_1' }),
      );
    });

    it('409s scan_in_progress without spending the rate-limit slot', async () => {
      const { service, prisma, scanQueueService, rateLimiter } = setup();
      prisma.scan.findFirst.mockResolvedValue({ id: 'scan_running' });

      await expect(
        service.requestRescan(ORG, REPO, pull.id, 'user_1'),
      ).rejects.toMatchObject({
        status: HttpStatus.CONFLICT,
        response: { message: 'scan_in_progress' },
      });
      expect(rateLimiter.tryAcquire).not.toHaveBeenCalled();
      expect(scanQueueService.enqueue).not.toHaveBeenCalled();
    });

    it('409s no_head_sha', async () => {
      const { service, prisma } = setup();
      prisma.pullRequest.findUnique.mockResolvedValue({
        ...pull,
        headSha: null,
      });
      await expect(
        service.requestRescan(ORG, REPO, pull.id, 'user_1'),
      ).rejects.toMatchObject({
        status: HttpStatus.CONFLICT,
        response: { message: 'no_head_sha' },
      });
    });

    it('429s a second request inside the window', async () => {
      const { service, rateLimiter, scanQueueService } = setup();
      rateLimiter.tryAcquire.mockResolvedValue(false);

      await expect(
        service.requestRescan(ORG, REPO, pull.id, 'user_1'),
      ).rejects.toMatchObject({ status: HttpStatus.TOO_MANY_REQUESTS });
      expect(scanQueueService.enqueue).not.toHaveBeenCalled();
    });
  });

  describe('getScan', () => {
    it('reports progress and queue position while queued', async () => {
      const { service, prisma, queue } = setup();
      prisma.scan.findUnique.mockResolvedValue({
        ...scan,
        status: ScanStatus.QUEUED,
      });
      queue.getJob.mockResolvedValue({
        progress: { step: 'fetch_diff', pct: 10 },
      });
      queue.getRanges.mockResolvedValue(['scan-other', 'scan-scan_1']);

      const result = await service.getScan(ORG, scan.id);

      expect(result.progress).toEqual({ step: 'fetch_diff', pct: 10 });
      expect(result.queuePosition).toBe(2);
      expect(result.suppressedCount).toBe(2);
    });

    it('does not touch the queue for a finished scan', async () => {
      const { service, queue } = setup();
      const result = await service.getScan(ORG, scan.id);
      expect(result.progress).toBeNull();
      expect(result.queuePosition).toBeNull();
      expect(queue.getJob).not.toHaveBeenCalled();
    });

    it('still answers from the DB when Redis is down', async () => {
      const { service, prisma, queue, logger } = setup();
      prisma.scan.findUnique.mockResolvedValue({
        ...scan,
        status: ScanStatus.RUNNING,
      });
      queue.getJob.mockRejectedValue(new Error('ECONNREFUSED'));

      const result = await service.getScan(ORG, scan.id);

      expect(result.status).toBe(ScanStatus.RUNNING);
      expect(result.progress).toBeNull();
      expect(logger.warn).toHaveBeenCalledWith(
        'scan.queue_unavailable',
        expect.anything(),
      );
    });
  });

  describe('findActiveScans', () => {
    it('keeps the newest in-flight scan per PR, in one query', async () => {
      const { service, prisma } = setup();
      prisma.scan.findMany.mockResolvedValue([
        { id: 'scan_new', pullId: 'pull_1', status: ScanStatus.RUNNING },
        { id: 'scan_old', pullId: 'pull_1', status: ScanStatus.QUEUED },
        { id: 'scan_b', pullId: 'pull_2', status: ScanStatus.QUEUED },
      ]);

      const active = await service.findActiveScans([
        'pull_1',
        'pull_2',
        'pull_3',
      ]);

      expect(prisma.scan.findMany).toHaveBeenCalledTimes(1);
      expect(active.get('pull_1')?.id).toBe('scan_new');
      expect(active.get('pull_2')?.id).toBe('scan_b');
      expect(active.has('pull_3')).toBe(false);
    });

    it('skips the query for an empty list', async () => {
      const { service, prisma } = setup();
      expect((await service.findActiveScans([])).size).toBe(0);
      expect(prisma.scan.findMany).not.toHaveBeenCalled();
    });
  });
});
