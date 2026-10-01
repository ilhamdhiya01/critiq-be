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
import { ScansService } from '../scans/scans.service';
import { PullSummaryService } from './pull-summary.service';

jest.mock('@nestjs/config', () => ({ ConfigService: class {} }));
jest.mock('../../common/prisma/prisma.service', () => ({
  PrismaService: class {},
}));
jest.mock('../../common/redis/rate-limiter.service', () => ({
  RateLimiterService: class {},
}));
jest.mock('../ai/scan/ai-scan.service', () => ({ AiScanService: class {} }));
jest.mock('../scans/scans.service', () => ({ ScansService: class {} }));

function latestScan(overrides: Record<string, unknown> = {}) {
  return {
    id: 'scan_1',
    status: ScanStatus.DONE,
    aiStatus: AiScanStatus.DONE,
    aiErrorCode: null,
    aiFlags: [],
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
  const scansService = {
    requestRescan: jest
      .fn()
      .mockResolvedValue({ scanId: 'scan_2', status: 'QUEUED' }),
  };
  const config = { getOrThrow: () => 204_800 };
  const logger = { info: jest.fn(), warn: jest.fn() };
  const service = new PullSummaryService(
    prisma as unknown as PrismaService,
    aiScanService as unknown as AiScanService,
    scansService as unknown as ScansService,
    rateLimiter as unknown as RateLimiterService,
    config as unknown as ConfigService,
    logger as unknown as Logger,
  );
  return { service, prisma, aiScanService, scansService, rateLimiter, logger };
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
      partial: false,
    });
  });

  it('marks a review the model left incomplete', async () => {
    const { service } = setup(latestScan({ aiFlags: ['partial_response'] }));
    const summary = await service.getSummary('org_1', 'repo_1', 'pull_1');
    expect(summary.partial).toBe(true);
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
  it('re-runs the AI on the existing scan without force', async () => {
    const { service, aiScanService, scansService, logger } = setup();
    await expect(
      service.regenerate('org_1', 'repo_1', 'pull_1', 'u_1', false),
    ).resolves.toEqual({ scanId: 'scan_1', aiStatus: 'queued' });
    expect(aiScanService.maybeEnqueue).toHaveBeenCalledWith('scan_1');
    expect(scansService.requestRescan).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      'audit.ai.regenerate_requested',
      expect.objectContaining({ by: 'u_1', force: false }),
    );
  });

  // v1.5.1 langkah 3: force = a new FULL scan, static and AI.
  it('starts a new full scan when forced', async () => {
    const { service, aiScanService, scansService } = setup();
    await expect(
      service.regenerate('org_1', 'repo_1', 'pull_1', 'u_1', true),
    ).resolves.toEqual({ scanId: 'scan_2', aiStatus: 'queued' });
    expect(scansService.requestRescan).toHaveBeenCalledWith(
      'org_1',
      'repo_1',
      'pull_1',
      'u_1',
      true,
    );
    expect(aiScanService.maybeEnqueue).not.toHaveBeenCalled();
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
