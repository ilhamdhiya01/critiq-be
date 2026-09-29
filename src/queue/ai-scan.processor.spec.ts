import { ConfigService } from '@nestjs/config';
import { Job } from 'bullmq';
import Redis from 'ioredis';
import { Logger } from 'winston';
import { EncryptionService } from '../common/encryption/encryption.service';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  AiScanStatus,
  FindingCategory,
  FindingSource,
  ScanStatus,
} from '../generated/prisma/enums';
import { AiError } from '../modules/ai/ai-error';
import { AiProviderFactory } from '../modules/ai/ai-provider.factory';
import { AiProvider, AiResult } from '../modules/ai/ai-provider.interface';
import { AiScanService } from '../modules/ai/scan/ai-scan.service';
import { PullsService } from '../modules/pulls/pulls.service';
import { AiJobPayload } from './ai-queue.constants';
import { AiJobFailure, AiScanProcessor } from './ai-scan.processor';

// ESM-only packages and heavy collaborators — all replaced by stubs.
jest.mock('@nestjs/config', () => ({ ConfigService: class {} }));
jest.mock('@nestjs/bullmq', () => ({
  Processor: () => () => undefined,
  OnWorkerEvent: () => () => undefined,
  WorkerHost: class {},
}));
jest.mock('bullmq', () => ({
  Job: class {},
  UnrecoverableError: class UnrecoverableError extends Error {},
}));
jest.mock('../common/prisma/prisma.service', () => ({
  PrismaService: class {},
}));
jest.mock('../common/encryption/encryption.service', () => ({
  EncryptionService: class {},
}));
jest.mock('../modules/pulls/pulls.service', () => ({ PullsService: class {} }));
jest.mock('../modules/ai/scan/ai-scan.service', () => ({
  AiScanService: class {},
}));
jest.mock('../modules/ai/ai-provider.factory', () => ({
  AiProviderFactory: class {},
}));

const CONFIG: Record<string, unknown> = {
  'ai.concurrency': 2,
  'ai.contextLines': 30,
  'ai.maxInputTokens': 60_000,
  'ai.maxOutputTokens': 4000,
  'ai.timeoutMs': 90_000,
  'ai.keepDeduped': false,
};

// src/session.ts, lines 1–6 added; a static secret finding on line 2.
const PATCH = [
  '@@ -0,0 +1,6 @@',
  "+import { refresh } from './auth';",
  "+const key = 'redacted-in-test';",
  '+export function rotate(session) {',
  '+  refresh(session).then(apply);',
  '+}',
  '+export default rotate;',
].join('\n');

const STATIC_SECRET = {
  id: 'f_static',
  ruleId: 'secret.assignment_literal',
  category: FindingCategory.SECRET,
  filePath: 'src/session.ts',
  lineStart: 2,
  lineEnd: 2,
  title: 'Hardcoded credential',
  suppressedReason: null,
  source: FindingSource.STATIC,
  status: 'NEW',
};

interface Review {
  summary: string;
  risk_level: 'low' | 'medium' | 'high';
  findings: Record<string, unknown>[];
}

function aiFinding(overrides: Record<string, unknown> = {}) {
  return {
    file: 'src/session.ts',
    line_start: 4,
    line_end: 4,
    category: 'error_handling',
    severity: 'critical',
    title: 'Unhandled promise rejection',
    message: 'refresh() can reject and nothing handles it here.',
    confidence: 0.9,
    ...overrides,
  };
}

function result(review: Review, overrides: Partial<AiResult> = {}): AiResult {
  return {
    toolInput: review,
    usage: { inputTokens: 1200, outputTokens: 150 },
    model: 'claude-sonnet-5',
    structuredOutput: 'native',
    ...overrides,
  };
}

function setup(
  options: { findingsCount?: number; staticFindings?: unknown[] } = {},
) {
  const tx = {
    scan: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn(),
    },
    finding: {
      deleteMany: jest.fn(),
      createMany: jest.fn(),
      // recomputeScanCounts
      groupBy: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    aiSummary: { deleteMany: jest.fn(), create: jest.fn() },
  };
  const prisma = {
    scan: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest
        .fn()
        .mockResolvedValue({ headSha: 'abc123', criticalCount: 0 }),
      findUniqueOrThrow: jest.fn().mockResolvedValue({
        id: 'scan_1',
        organizationId: 'org_1',
        repositoryId: 'repo_1',
        pullId: 'pull_1',
        headSha: 'abc123',
        rulesetVersion: '2026.09.5',
        status: ScanStatus.DONE,
        findingsCount: options.findingsCount ?? 1,
        aiModel: 'claude-sonnet-5',
        diffMode: 'FULL',
        baseScanId: null,
        prevHeadSha: null,
        pullRequest: {
          title: 'Rotate sessions',
          description: null,
          sourceBranch: 'feature/rotate',
          targetBranch: 'main',
        },
        repository: { path: 'acme/api' },
        organization: { aiLocale: 'en' },
      }),
    },
    finding: {
      // This scan's findings; the lifecycle queries (resolved pool,
      // window misses) find nothing.
      findMany: jest.fn(
        (args: { where?: Record<string, unknown>; distinct?: unknown }) =>
          Promise.resolve(
            args.distinct || args.where?.status === 'RESOLVED' || args.where?.OR
              ? []
              : (options.staticFindings ?? [STATIC_SECRET]),
          ),
      ),
      count: jest.fn().mockResolvedValue(0),
    },
    $transaction: jest.fn((run: (client: typeof tx) => Promise<unknown>) =>
      run(tx),
    ),
  };
  const provider: jest.Mocked<AiProvider> = {
    id: 'anthropic',
    complete: jest.fn(),
    healthcheck: jest.fn(),
  };
  const factory = { for: jest.fn().mockResolvedValue(provider) };
  const pullsService = {
    getDiff: jest.fn().mockResolvedValue({
      files: [
        {
          path: 'src/session.ts',
          previousPath: null,
          status: 'added',
          patch: PATCH,
        },
      ],
    }),
    getHeadFileContents: jest.fn().mockResolvedValue(new Map()),
  };
  const aiScanService = {
    recordUsage: jest.fn(),
    rememberInCache: jest.fn(),
  };
  const redis = {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
  };
  const encryption = {
    encrypt: jest.fn((text: string) => `enc(${text.length})`),
  };
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };
  const config = {
    getOrThrow: (key: string) => CONFIG[key],
    get: (key: string) => CONFIG[key],
  };

  const processor = new AiScanProcessor(
    prisma as unknown as PrismaService,
    pullsService as unknown as PullsService,
    aiScanService as unknown as AiScanService,
    factory as unknown as AiProviderFactory,
    encryption as unknown as EncryptionService,
    config as unknown as ConfigService,
    redis as unknown as Redis,
    logger as unknown as Logger,
  );
  return {
    processor,
    prisma,
    tx,
    provider,
    factory,
    pullsService,
    aiScanService,
    redis,
    logger,
  };
}

const job = {
  id: 'ai-scan_1-1',
  data: { scanId: 'scan_1', organizationId: 'org_1', pullId: 'pull_1' },
  attemptsMade: 0,
  opts: { attempts: 4 },
} as unknown as Job<AiJobPayload>;

function scanUpdate(tx: ReturnType<typeof setup>['tx']) {
  const [args] = tx.scan.updateMany.mock.calls[0] as [
    { data: Record<string, unknown> },
  ];
  return args.data;
}

function createdFindings(tx: ReturnType<typeof setup>['tx']) {
  const call = tx.finding.createMany.mock.calls[0] as
    [{ data: Record<string, unknown>[] }] | undefined;
  return call ? call[0].data : [];
}

describe('AiScanProcessor', () => {
  // Acceptance 1.
  it('stores the summary and AI findings, and records usage and cache', async () => {
    const { processor, tx, provider, aiScanService } = setup();
    provider.complete.mockResolvedValue(
      result({
        summary: 'Adds rotation.',
        risk_level: 'high',
        findings: [aiFinding()],
      }),
    );

    await processor.process(job);

    expect(scanUpdate(tx)).toMatchObject({
      aiStatus: AiScanStatus.DONE,
      aiTokensIn: 1200,
      aiTokensOut: 150,
    });
    // Counts are rebuilt from the rows (v1.5.1 langkah 3).
    expect(tx.finding.groupBy).toHaveBeenCalled();
    expect(tx.aiSummary.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        summaryMd: 'Adds rotation.',
        riskLevel: 'HIGH',
      }) as unknown,
    });
    expect(createdFindings(tx)).toEqual([
      expect.objectContaining({
        source: FindingSource.AI,
        ruleId: 'ai.error_handling',
        category: FindingCategory.ERROR_HANDLING,
        lineStart: 4,
        status: 'NEW',
        firstSeenScanId: 'scan_1',
        pullId: 'pull_1',
      }),
    ]);
    expect(aiScanService.recordUsage).toHaveBeenCalledWith('org_1', {
      inputTokens: 1200,
      outputTokens: 150,
    });
    expect(aiScanService.rememberInCache).toHaveBeenCalled();
  });

  it('never sends the flagged secret line to the provider', async () => {
    const { processor, provider } = setup();
    provider.complete.mockResolvedValue(
      result({ summary: 's', risk_level: 'low', findings: [] }),
    );
    await processor.process(job);
    const [request] = provider.complete.mock.calls[0];
    expect(request.user).not.toContain('redacted-in-test');
  });

  // Acceptance 4 (and 5 in ai-deduper.spec.ts).
  it('drops an AI finding that duplicates the static one', async () => {
    const { processor, tx, provider } = setup();
    provider.complete.mockResolvedValue(
      result({
        summary: 's',
        risk_level: 'high',
        findings: [
          aiFinding({ line_start: 2, line_end: 2, category: 'secret' }),
        ],
      }),
    );
    await processor.process(job);
    expect(scanUpdate(tx)).toMatchObject({
      aiFindingsDeduped: 1,
    });
    expect(createdFindings(tx)).toEqual([]);
  });

  // Acceptance 8.
  it('notifies for AI criticals only when static found none', async () => {
    const quiet = setup({ findingsCount: 0, staticFindings: [] });
    quiet.provider.complete.mockResolvedValue(
      result({ summary: 's', risk_level: 'high', findings: [aiFinding()] }),
    );
    await quiet.processor.process(job);
    expect(quiet.logger.warn).toHaveBeenCalledWith(
      'notification.pull_critical_found',
      expect.objectContaining({ source: 'ai', criticalCount: 1 }),
    );

    const loud = setup({ findingsCount: 2 });
    loud.provider.complete.mockResolvedValue(
      result({ summary: 's', risk_level: 'high', findings: [aiFinding()] }),
    );
    await loud.processor.process(job);
    expect(loud.logger.warn).not.toHaveBeenCalledWith(
      'notification.pull_critical_found',
      expect.anything(),
    );
  });

  // Acceptance 9.
  it('fails with invalid_response after one retry and keeps the raw answer', async () => {
    const { processor, provider, redis, prisma } = setup();
    provider.complete.mockResolvedValue(
      result({ nonsense: true } as unknown as Review),
    );

    await expect(processor.process(job)).rejects.toMatchObject({
      code: 'invalid_response',
    });
    expect(provider.complete.mock.calls).toHaveLength(2);
    const [, retryRequest] = provider.complete.mock.calls.map(([r]) => r);
    expect(retryRequest.system).toContain('previous response was not a valid');
    expect(redis.set).toHaveBeenCalledWith(
      'ai:raw:scan_1',
      expect.stringMatching(/^enc\(/),
      'EX',
      30 * 86_400,
    );
    expect(prisma.scan.update).toHaveBeenCalledWith({
      where: { id: 'scan_1' },
      data: { aiRawRef: 'ai:raw:scan_1' },
    });
  });

  // Acceptance 10.
  it('hands retryable errors back to BullMQ and fails auth errors at once', async () => {
    const limited = setup();
    limited.provider.complete.mockRejectedValue(new AiError('rate_limited'));
    const error = await limited.processor.process(job).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiError);
    expect(error).not.toBeInstanceOf(AiJobFailure);

    const denied = setup();
    denied.provider.complete.mockRejectedValue(
      new AiError('auth_failed', { status: 401 }),
    );
    await expect(denied.processor.process(job)).rejects.toBeInstanceOf(
      AiJobFailure,
    );
  });

  it('marks FAILED on the final attempt and notifies auth failures once', async () => {
    const { processor, prisma, redis, logger } = setup();

    await processor.onFailed(job, new AiJobFailure('auth_failed'));
    expect(prisma.scan.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          aiStatus: AiScanStatus.FAILED,
          aiErrorCode: 'auth_failed',
        }) as unknown,
      }),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      'notification.ai_provider_auth_failed',
      expect.anything(),
    );

    redis.set.mockResolvedValue(null);
    logger.warn.mockClear();
    await processor.onFailed(job, new AiJobFailure('auth_failed'));
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('does not settle a failure that BullMQ will still retry', async () => {
    const { processor, prisma } = setup();
    await processor.onFailed(
      { ...job, attemptsMade: 1 } as unknown as Job<AiJobPayload>,
      new AiError('rate_limited'),
    );
    expect(prisma.scan.updateMany).not.toHaveBeenCalled();
  });

  // Acceptance 16: the pipeline does not care how structure was forced.
  it('accepts a JSON-mode answer from an OpenAI-compatible server', async () => {
    const { processor, tx, provider } = setup();
    provider.complete.mockResolvedValue(
      result(
        { summary: 's', risk_level: 'medium', findings: [aiFinding()] },
        { structuredOutput: 'json_mode', model: 'llama-3.1-70b-instruct' },
      ),
    );
    await processor.process(job);
    expect(scanUpdate(tx)).toMatchObject({ aiStatus: AiScanStatus.DONE });
  });

  // Acceptance 17.
  it('flags a low-risk empty review of a scan with static criticals', async () => {
    const { processor, tx, provider } = setup({ findingsCount: 1 });
    provider.complete.mockResolvedValue(
      result({ summary: 'Looks fine.', risk_level: 'low', findings: [] }),
    );
    await processor.process(job);
    expect(scanUpdate(tx)).toMatchObject({ aiFlags: ['suspicious_low_risk'] });
  });

  it('settles as not_configured when settings changed after queueing', async () => {
    const { processor, factory, prisma, provider } = setup();
    factory.for.mockRejectedValue(new AiError('api_key_required'));
    await processor.process(job);
    expect(prisma.scan.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          aiStatus: AiScanStatus.NOT_CONFIGURED,
        }) as unknown,
      }),
    );
    expect(provider.complete.mock.calls).toHaveLength(0);
  });

  it('uses cached head files instead of refetching them', async () => {
    const { processor, provider, redis, pullsService } = setup();
    redis.get.mockResolvedValue('line one\nline two');
    provider.complete.mockResolvedValue(
      result({ summary: 's', risk_level: 'low', findings: [] }),
    );
    await processor.process(job);
    expect(pullsService.getHeadFileContents).not.toHaveBeenCalled();
  });
});
