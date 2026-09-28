import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { Logger } from 'winston';
import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  AiProviderId,
  AiRiskLevel,
  AiScanStatus,
  FindingCategory,
  FindingSeverity,
  FindingSource,
  ReviewPolicy,
  ScanStatus,
} from '../../../generated/prisma/enums';
import { AiJobPayload } from '../../../queue/ai-queue.constants';
import { AiScanService } from './ai-scan.service';

// ESM-only packages this CommonJS Jest setup cannot load.
jest.mock('@nestjs/config', () => ({ ConfigService: class {} }));
jest.mock('@nestjs/bullmq', () => ({ InjectQueue: () => () => undefined }));
jest.mock('bullmq', () => ({ Queue: class {} }));
jest.mock('../../../common/prisma/prisma.service', () => ({
  PrismaService: class {},
}));

const CONFIG: Record<string, unknown> = {
  'ai.maxDiffBytes': 204_800,
  'ai.keepDeduped': false,
};

function scanRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'scan_2',
    organizationId: 'org_1',
    repositoryId: 'repo_1',
    pullId: 'pull_1',
    headSha: 'abc123',
    rulesetVersion: '2026.09.5',
    status: ScanStatus.DONE,
    diffBytes: 50_000,
    findingsCount: 1,
    aiStatus: null,
    pullRequest: { effectivePolicy: ReviewPolicy.ALLOW_AI },
    organization: {
      aiProvider: AiProviderId.ANTHROPIC,
      aiModel: 'claude-sonnet-5',
      aiConsentAt: new Date(),
      aiDailyTokenBudget: 2_000_000,
    },
    ...overrides,
  };
}

function setup(scan = scanRow()) {
  const tx = {
    scan: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    finding: {
      deleteMany: jest.fn(),
      createMany: jest.fn(),
    },
    aiSummary: { deleteMany: jest.fn(), create: jest.fn() },
  };
  const prisma = {
    scan: {
      // Returns unknown so a test can serve other scan shapes (the cache
      // source) through the same mock.
      findUnique: jest.fn((args: { where: { id: string } }): Promise<unknown> =>
        Promise.resolve(args.where.id === scan.id ? scan : null),
      ),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn(),
    },
    aiCredential: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ encryptedKey: 'enc', baseUrl: null }),
    },
    aiUsageDaily: { findUnique: jest.fn().mockResolvedValue(null) },
    finding: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn((run: (client: typeof tx) => Promise<unknown>) =>
      run(tx),
    ),
  };
  const queue = { add: jest.fn().mockResolvedValue({}) };
  const redis = {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
  };
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const config = {
    getOrThrow: (key: string) => CONFIG[key],
    get: (key: string) => CONFIG[key],
  };
  const service = new AiScanService(
    prisma as unknown as PrismaService,
    config as unknown as ConfigService,
    queue as unknown as Queue<AiJobPayload>,
    redis as unknown as Redis,
    logger as unknown as Logger,
  );
  return { service, prisma, tx, queue, redis, logger };
}

function statusWritten(prisma: ReturnType<typeof setup>['prisma']) {
  const calls = prisma.scan.updateMany.mock.calls as [
    { data: { aiStatus: AiScanStatus } },
  ][];
  return calls.map(([args]) => args.data.aiStatus);
}

describe('AiScanService.maybeEnqueue', () => {
  it('does nothing for a scan that is not DONE', async () => {
    const { service, queue } = setup(scanRow({ status: ScanStatus.FAILED }));
    await expect(service.maybeEnqueue('scan_2')).resolves.toBeNull();
    expect(queue.add).not.toHaveBeenCalled();
  });

  // Acceptance 2.
  it('skips Manual-only branches without touching the provider', async () => {
    const { service, prisma, queue } = setup(
      scanRow({ pullRequest: { effectivePolicy: ReviewPolicy.MANUAL_ONLY } }),
    );
    await expect(service.maybeEnqueue('scan_2')).resolves.toBe(
      AiScanStatus.SKIPPED_MANUAL_MODE,
    );
    expect(statusWritten(prisma)).toEqual([AiScanStatus.SKIPPED_MANUAL_MODE]);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('reports not_configured without a provider or key', async () => {
    const { service, prisma } = setup();
    prisma.aiCredential.findUnique.mockResolvedValue({
      encryptedKey: null,
      baseUrl: null,
    });
    await expect(service.maybeEnqueue('scan_2')).resolves.toBe(
      AiScanStatus.NOT_CONFIGURED,
    );
  });

  // Acceptance 3.
  it('reports consent_required without consent', async () => {
    const scan = scanRow();
    scan.organization.aiConsentAt = null as never;
    const { service, queue } = setup(scan);
    await expect(service.maybeEnqueue('scan_2')).resolves.toBe(
      AiScanStatus.CONSENT_REQUIRED,
    );
    expect(queue.add).not.toHaveBeenCalled();
  });

  // Acceptance 12.
  it('skips a diff over AI_MAX_DIFF_BYTES', async () => {
    const { service } = setup(scanRow({ diffBytes: 300 * 1024 }));
    await expect(service.maybeEnqueue('scan_2')).resolves.toBe(
      AiScanStatus.SKIPPED_TOO_LARGE,
    );
  });

  // Acceptance 13. The prompt's "budget 100k, estimate 120k" cannot happen
  // on its own: 120k estimated tokens is ~420 KB of diff, which the size
  // check (AI_MAX_DIFF_BYTES 200 KB) stops first. The realistic case is a
  // budget already partly spent that day.
  it('stops at the daily budget and notifies once per day', async () => {
    const scan = scanRow({ diffBytes: 105_000 }); // ~30k tokens
    scan.organization.aiDailyTokenBudget = 100_000;
    const { service, prisma, redis, logger } = setup(scan);
    prisma.aiUsageDaily.findUnique.mockResolvedValue({
      inputTokens: 75_000,
      outputTokens: 5_000,
    });

    await expect(service.maybeEnqueue('scan_2')).resolves.toBe(
      AiScanStatus.BUDGET_EXCEEDED,
    );
    expect(logger.warn).toHaveBeenCalledWith(
      'notification.ai_budget_exceeded',
      expect.anything(),
    );

    redis.set.mockResolvedValue(null); // NX: already notified today
    logger.warn.mockClear();
    await service.maybeEnqueue('scan_2');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('enqueues one job and marks the scan QUEUED', async () => {
    const { service, prisma, queue } = setup();
    await expect(service.maybeEnqueue('scan_2')).resolves.toBe(
      AiScanStatus.QUEUED,
    );
    expect(statusWritten(prisma)).toEqual([AiScanStatus.QUEUED]);
    const [name, payload, options] = queue.add.mock.calls[0] as [
      string,
      AiJobPayload,
      { jobId: string; attempts: number },
    ];
    expect(name).toBe('ai');
    expect(payload).toEqual({
      scanId: 'scan_2',
      organizationId: 'org_1',
      pullId: 'pull_1',
    });
    expect(options.jobId).toMatch(/^ai-scan_2-\d+$/);
    expect(options.attempts).toBe(4);
  });

  // Acceptance 11.
  it('copies a cached result instead of calling the provider', async () => {
    const { service, prisma, tx, queue, redis } = setup();
    redis.get.mockResolvedValue('scan_1');
    prisma.scan.findUnique.mockImplementation(
      (args: { where: { id: string } }) =>
        Promise.resolve(
          args.where.id === 'scan_1'
            ? {
                id: 'scan_1',
                organizationId: 'org_1',
                aiStatus: AiScanStatus.DONE,
                aiProvider: 'anthropic',
                aiModel: 'claude-sonnet-5',
                aiPromptVersion: 'ai-2026.09.2',
                aiSummary: {
                  summaryMd: 'Adds refresh.',
                  riskLevel: AiRiskLevel.MEDIUM,
                  filesOmitted: [],
                },
                findings: [
                  {
                    filePath: 'src/session.ts',
                    lineStart: 110,
                    lineEnd: 110,
                    category: FindingCategory.ERROR_HANDLING,
                    severity: FindingSeverity.CRITICAL,
                    title: 'Unhandled rejection',
                    message: 'The promise rejection is never handled here.',
                    confidence: 0.9,
                    source: FindingSource.AI,
                  },
                ],
              }
            : scanRow(),
        ),
    );

    await expect(service.maybeEnqueue('scan_2')).resolves.toBe(
      AiScanStatus.CACHED,
    );
    expect(queue.add).not.toHaveBeenCalled();
    const [update] = tx.scan.updateMany.mock.calls[0] as [
      { data: Record<string, unknown> },
    ];
    expect(update.data).toMatchObject({
      aiStatus: AiScanStatus.CACHED,
      aiCached: true,
      criticalCount: 2, // 1 static + 1 AI critical
    });
    expect(tx.finding.createMany).toHaveBeenCalled();
  });

  it('skips the cache when forced', async () => {
    const { service, redis, queue } = setup();
    redis.get.mockResolvedValue('scan_1');
    await expect(service.maybeEnqueue('scan_2', { force: true })).resolves.toBe(
      AiScanStatus.QUEUED,
    );
    expect(redis.get).not.toHaveBeenCalled();
    expect(queue.add).toHaveBeenCalled();
  });
});
