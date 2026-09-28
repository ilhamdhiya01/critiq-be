import { HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Logger } from 'winston';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RateLimiterService } from '../../common/redis/rate-limiter.service';
import {
  AiRiskLevel,
  AiScanStatus,
  ScanStatus,
} from '../../generated/prisma/enums';
import { AiScanService } from '../ai/scan/ai-scan.service';
import { PullSummaryService } from './pull-summary.service';

jest.mock('@nestjs/config', () => ({ ConfigService: class {} }));
jest.mock('../../common/prisma/prisma.service', () => ({
  PrismaService: class {},
}));
jest.mock('../../common/redis/rate-limiter.service', () => ({
  RateLimiterService: class {},
}));
jest.mock('../ai/scan/ai-scan.service', () => ({ AiScanService: class {} }));

function latestScan(overrides: Record<string, unknown> = {}) {
  return {
    id: 'scan_1',
    status: ScanStatus.DONE,
    aiStatus: AiScanStatus.DONE,
    aiErrorCode: null,
    aiProvider: 'anthropic',
    aiModel: 'claude-sonnet-5',
    aiCached: false,
    aiTokensIn: 42_100,
    aiTokensOut: 1800,
    diffBytes: 50_000,
    aiSummary: {
      summaryMd: 'Adds session rotation.',
      riskLevel: AiRiskLevel.HIGH,
      filesOmitted: [],
      createdAt: new Date('2026-09-28T10:00:00Z'),
    },
    ...overrides,
  };
}

function setup(scan: Record<string, unknown> | null = latestScan()) {
  const prisma = {
    pullRequest: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'pull_1',
        organizationId: 'org_1',
        repositoryId: 'repo_1',
        latestScan: scan,
      }),
    },
  };
  const aiScanService = {
    maybeEnqueue: jest.fn().mockResolvedValue(AiScanStatus.QUEUED),
  };
  const rateLimiter = { tryAcquire: jest.fn().mockResolvedValue(true) };
  const config = { getOrThrow: () => 204_800 };
  const logger = { info: jest.fn(), warn: jest.fn() };
  const service = new PullSummaryService(
    prisma as unknown as PrismaService,
    aiScanService as unknown as AiScanService,
    rateLimiter as unknown as RateLimiterService,
    config as unknown as ConfigService,
    logger as unknown as Logger,
  );
  return { service, prisma, aiScanService, rateLimiter, logger };
}

describe('PullSummaryService.getSummary', () => {
  it('returns the summary of the latest scan', async () => {
    const { service } = setup();
    await expect(
      service.getSummary('org_1', 'repo_1', 'pull_1'),
    ).resolves.toMatchObject({
      scanId: 'scan_1',
      aiStatus: 'done',
      summaryMd: 'Adds session rotation.',
      riskLevel: 'high',
      tokens: { in: 42_100, out: 1800 },
      error: null,
    });
  });

  // Acceptance 3 and 12.
  it.each([
    [
      AiScanStatus.CONSENT_REQUIRED,
      'consent_required',
      /Settings → AI Provider/,
    ],
    [AiScanStatus.NOT_CONFIGURED, 'not_configured', /Settings → AI Provider/],
    [AiScanStatus.SKIPPED_MANUAL_MODE, 'skipped_manual_mode', /Manual only/],
    [AiScanStatus.SKIPPED_TOO_LARGE, 'skipped_too_large', /293 KB > 200 KB/],
    [AiScanStatus.BUDGET_EXCEEDED, 'budget_exceeded', /00:00 UTC/],
  ])('explains %s', async (aiStatus, code, hint) => {
    const { service } = setup(
      latestScan({ aiStatus, aiSummary: null, diffBytes: 300_000 }),
    );
    const summary = await service.getSummary('org_1', 'repo_1', 'pull_1');
    expect(summary.summaryMd).toBeNull();
    expect(summary.error?.code).toBe(code);
    expect(summary.error?.hint).toMatch(hint);
  });

  it('404s a PR from another organization', async () => {
    const { service } = setup();
    await expect(
      service.getSummary('org_other', 'repo_1', 'pull_1'),
    ).rejects.toMatchObject({
      status: HttpStatus.NOT_FOUND,
    });
  });
});

describe('PullSummaryService.regenerate', () => {
  it('queues a new run', async () => {
    const { service, aiScanService, logger } = setup();
    await expect(
      service.regenerate('org_1', 'repo_1', 'pull_1', 'u_1', true),
    ).resolves.toEqual({ scanId: 'scan_1', aiStatus: 'queued' });
    expect(aiScanService.maybeEnqueue).toHaveBeenCalledWith('scan_1', {
      force: true,
    });
    expect(logger.info).toHaveBeenCalledWith(
      'audit.ai.regenerate_requested',
      expect.objectContaining({ by: 'u_1', force: true }),
    );
  });

  it('409s while a run is in flight', async () => {
    const { service, rateLimiter } = setup(
      latestScan({ aiStatus: AiScanStatus.RUNNING }),
    );
    await expect(
      service.regenerate('org_1', 'repo_1', 'pull_1', 'u_1', false),
    ).rejects.toMatchObject({ status: HttpStatus.CONFLICT });
    expect(rateLimiter.tryAcquire).not.toHaveBeenCalled();
  });

  it('412s with the failing prerequisite', async () => {
    const { service, aiScanService } = setup();
    aiScanService.maybeEnqueue.mockResolvedValue(AiScanStatus.CONSENT_REQUIRED);
    await expect(
      service.regenerate('org_1', 'repo_1', 'pull_1', 'u_1', false),
    ).rejects.toMatchObject({
      status: HttpStatus.PRECONDITION_FAILED,
      response: { message: 'consent_required' },
    });
  });

  it('412s when the static scan is not done', async () => {
    const { service } = setup(latestScan({ status: ScanStatus.FAILED }));
    await expect(
      service.regenerate('org_1', 'repo_1', 'pull_1', 'u_1', false),
    ).rejects.toMatchObject({ status: HttpStatus.PRECONDITION_FAILED });
  });

  it('429s a second request within two minutes', async () => {
    const { service, rateLimiter } = setup();
    rateLimiter.tryAcquire.mockResolvedValue(false);
    await expect(
      service.regenerate('org_1', 'repo_1', 'pull_1', 'u_1', false),
    ).rejects.toMatchObject({ status: HttpStatus.TOO_MANY_REQUESTS });
  });
});
