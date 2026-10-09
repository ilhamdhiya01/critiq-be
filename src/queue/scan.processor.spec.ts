import { UnprocessableEntityException } from '@nestjs/common';
import { createHash } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { Job } from 'bullmq';
import Redis from 'ioredis';
import { Logger } from 'winston';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  AiScanStatus,
  DiffMode,
  FindingCategory,
  FindingSeverity,
  FindingSource,
  FindingStatus,
  FullReason,
  ScanErrorCode,
} from '../generated/prisma/enums';
import { AiScanService } from '../modules/ai/scan/ai-scan.service';
import { PullsService } from '../modules/pulls/pulls.service';
import { StoredFinding } from './lifecycle/plan-findings';
import { ScanFailure } from './scan-errors';
import { ScanJobPayload } from './scan-payload.dto';
import { ScanProcessor } from './scan.processor';

// ESM-only packages and heavy collaborators — all replaced by stubs.
jest.mock('@nestjs/config', () => ({ ConfigService: class {} }));
jest.mock('@nestjs/bullmq', () => ({
  InjectQueue: () => () => undefined,
  Processor: () => () => undefined,
  OnWorkerEvent: () => () => undefined,
  WorkerHost: class {},
}));
jest.mock('bullmq', () => ({
  Job: class {},
  Queue: class {},
  UnrecoverableError: class UnrecoverableError extends Error {},
}));
jest.mock('../common/prisma/prisma.service', () => ({
  PrismaService: class {},
}));
jest.mock('../modules/pulls/pulls.service', () => ({ PullsService: class {} }));
jest.mock('../generated/prisma/client', () => ({
  Prisma: { PrismaClientKnownRequestError: class {} },
}));
jest.mock('../modules/ai/scan/ai-scan.service', () => ({
  AiScanService: class {},
}));

const CONFIG: Record<string, unknown> = {
  'scan.concurrency': 3,
  'scan.jobTimeoutMs': 120_000,
  'scan.maxDiffBytes': 1_048_576,
  'scan.syntaxMaxFiles': 50,
};

function stored(
  id: string,
  filePath: string,
  line: number,
  overrides: Partial<StoredFinding> = {},
): StoredFinding {
  return {
    id,
    source: FindingSource.STATIC,
    ruleId: 'code.sql_string_concat',
    severity: FindingSeverity.CRITICAL,
    title: 'SQL built by string concatenation',
    message: 'Use parameters.',
    filePath,
    lineStart: line,
    lineEnd: line,
    snippet: null,
    fingerprint: `fp-${id}`,
    suppressedReason: null,
    category: FindingCategory.INJECTION,
    confidence: null,
    firstSeenScanId: 'scan_1',
    ...overrides,
  };
}

// Acceptance 1's push 1: 2 static criticals, 1 AI critical, 1 AI major.
const BASE: StoredFinding[] = [
  stored('s_config', 'src/config.ts', 47),
  stored('s_roles', 'src/auth/roles.ts', 64),
  stored('a_session', 'src/auth/session.ts', 110, {
    source: FindingSource.AI,
    ruleId: 'ai.error_handling',
    category: FindingCategory.ERROR_HANDLING,
    title: 'Missing error handling in critical path',
  }),
  stored('a_roles', 'src/auth/roles.ts', 88, {
    source: FindingSource.AI,
    ruleId: 'ai.performance',
    severity: FindingSeverity.MAJOR,
    category: FindingCategory.PERFORMANCE,
    title: 'N+1 query in role resolver',
  }),
];

// Push 2 fixes lines 47 and 110 with code no rule flags; roles.ts untouched.
const PUSH_2 = [
  {
    path: 'src/config.ts',
    previousPath: null,
    status: 'modified' as const,
    patch: '@@ -47,1 +47,1 @@\n-const q = "x" + id;\n+const total = count + 1;',
  },
  {
    path: 'src/auth/session.ts',
    previousPath: null,
    status: 'modified' as const,
    patch:
      '@@ -110,1 +110,1 @@\n-refresh(s).then(apply);\n+await refresh(s).then(apply);',
  },
];

type Row = Record<string, unknown> & {
  id: string;
  status: FindingStatus;
  severity: FindingSeverity;
  source: FindingSource;
  suppressedReason: unknown;
  originFindingId: string | null;
};

function setup(options: {
  base?: StoredFinding[];
  compare?: { files: typeof PUSH_2; ancestor: boolean };
  aiStatus?: AiScanStatus;
  resolvedCritical?: number;
  // Head file contents for the syntax check; files not listed are
  // unavailable (null), so it decides nothing about them.
  heads?: Record<string, string>;
}) {
  const written: Row[] = [];
  const tx = {
    scan: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn(),
    },
    finding: {
      createMany: jest.fn(({ data }: { data: Row[] }) => {
        written.push(...data);
        return Promise.resolve({ count: data.length });
      }),
      // recomputeScanCounts, computed from what was actually written.
      groupBy: jest.fn(() => {
        const groups = new Map<
          string,
          {
            status: string;
            severity: string;
            source: string;
            _count: { _all: number };
          }
        >();
        for (const row of written.filter((r) => r.suppressedReason === null)) {
          const key = `${row.status}|${row.severity}|${row.source}`;
          const group = groups.get(key) ?? {
            status: row.status,
            severity: row.severity,
            source: row.source,
            _count: { _all: 0 },
          };
          group._count._all += 1;
          groups.set(key, group);
        }
        return Promise.resolve([...groups.values()]);
      }),
      count: jest.fn(() => {
        const resolvedIds = new Set(
          written
            .filter((r) => r.status === FindingStatus.RESOLVED)
            .map((r) => r.id),
        );
        return Promise.resolve(
          written.filter(
            (r) =>
              r.status === FindingStatus.REOPENED &&
              r.originFindingId !== null &&
              resolvedIds.has(r.originFindingId),
          ).length,
        );
      }),
    },
    pullRequest: { update: jest.fn() },
  };
  const prisma = {
    scan: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(() =>
        Promise.resolve({
          criticalCount: written.filter(
            (r) =>
              r.suppressedReason === null &&
              r.severity === FindingSeverity.CRITICAL &&
              r.status !== FindingStatus.RESOLVED,
          ).length,
        }),
      ),
      findUniqueOrThrow: jest.fn().mockResolvedValue({
        headSha: 'bbb222',
        diffMode: options.compare ? DiffMode.INCREMENTAL : DiffMode.FULL,
        baseScanId: options.base ? 'scan_1' : null,
        prevHeadSha: options.compare ? 'aaa111' : null,
      }),
    },
    finding: {
      findMany: jest.fn(
        (args: { where?: Record<string, unknown>; distinct?: unknown }) =>
          Promise.resolve(
            args.where?.scanId === 'scan_1' && !args.distinct
              ? (options.base ?? [])
              : [],
          ),
      ),
      count: jest.fn().mockResolvedValue(options.resolvedCritical ?? 0),
    },
    $transaction: jest.fn((run: (client: typeof tx) => Promise<unknown>) =>
      run(tx),
    ),
  };
  const pullsService = {
    getDiff: jest.fn().mockResolvedValue({ files: [], truncated: false }),
    getCompareDiff: jest.fn().mockResolvedValue({
      ...(options.compare ?? { files: [], ancestor: true }),
      truncated: false,
    }),
    getHeadFileContents: jest.fn(
      (
        _org: string,
        _repo: string,
        _pull: string,
        _sha: string,
        paths: string[],
      ) =>
        Promise.resolve(
          new Map(paths.map((path) => [path, options.heads?.[path] ?? null])),
        ),
    ),
  };
  const aiScanService = {
    maybeEnqueue: jest
      .fn()
      .mockResolvedValue(options.aiStatus ?? AiScanStatus.SKIPPED_MANUAL_MODE),
  };
  const redis = {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
  };
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };
  const config = { getOrThrow: (key: string) => CONFIG[key] };

  const processor = new ScanProcessor(
    prisma as unknown as PrismaService,
    pullsService as unknown as PullsService,
    aiScanService as unknown as AiScanService,
    config as unknown as ConfigService,
    redis as unknown as Redis,
    logger as unknown as Logger,
  );
  return { processor, prisma, tx, pullsService, logger, written };
}

const job = {
  id: 'scan-scan_2',
  data: {
    scanId: 'scan_2',
    organizationId: 'org_1',
    repositoryId: 'repo_1',
    pullId: 'pull_1',
  },
  attemptsMade: 0,
  opts: { attempts: 3 },
  updateProgress: jest.fn(),
} as unknown as Job<ScanJobPayload>;

function countsWritten(tx: ReturnType<typeof setup>['tx']) {
  const [args] = tx.scan.update.mock.calls[0] as [
    { data: Record<string, number> },
  ];
  return args.data;
}

describe('ScanProcessor — lifecycle (v1.5.1 langkah 3)', () => {
  // Acceptance 1.
  it('carries the base forward through an incremental diff', async () => {
    const { processor, tx, pullsService, written } = setup({
      base: BASE,
      compare: { files: PUSH_2, ancestor: true },
    });

    await processor.process(job);

    expect(pullsService.getCompareDiff).toHaveBeenCalledWith(
      'org_1',
      'repo_1',
      'pull_1',
      'aaa111',
      'bbb222',
    );
    expect(pullsService.getDiff).not.toHaveBeenCalled();
    expect(countsWritten(tx)).toMatchObject({
      resolvedCount: 2,
      persistedCount: 2,
      newCount: 0,
      criticalCount: 1,
      majorCount: 1,
    });
    const resolved = written.filter((r) => r.status === FindingStatus.RESOLVED);
    expect(resolved.map((r) => r.originFindingId).sort()).toEqual([
      'a_session',
      's_config',
    ]);
    expect(resolved.every((r) => r.resolvedInScanId === 'scan_2')).toBe(true);
    expect(written.every((r) => r.pullId === 'pull_1')).toBe(true);
  });

  // Acceptance 5.
  it('turns into a full scan on a force-push', async () => {
    const { processor, prisma, pullsService, written } = setup({
      base: BASE,
      compare: { files: PUSH_2, ancestor: false },
    });

    await processor.process(job);

    expect(prisma.scan.update).toHaveBeenCalledWith({
      where: { id: 'scan_2' },
      data: {
        diffMode: DiffMode.FULL,
        fullReason: FullReason.FORCE_PUSH,
        prevHeadSha: null,
      },
    });
    expect(pullsService.getDiff).toHaveBeenCalled();
    // Full with a base: static findings are matched by fingerprint — none
    // were re-found, so both are resolved. AI findings are the AI step's.
    expect(
      written
        .filter((r) => r.status === FindingStatus.RESOLVED)
        .map((r) => r.originFindingId)
        .sort(),
    ).toEqual(['s_config', 's_roles']);
    expect(written.some((r) => r.source === FindingSource.AI)).toBe(false);
  });

  // Acceptance 8.
  it('persists everything on a rescan with no new commits', async () => {
    const { processor, tx } = setup({
      base: BASE,
      compare: { files: [], ancestor: true },
    });

    await processor.process(job);

    expect(countsWritten(tx)).toMatchObject({
      persistedCount: 4,
      resolvedCount: 0,
      newCount: 0,
    });
  });

  // Acceptance 10.
  it('notifies when the last critical was resolved and no AI follows', async () => {
    const { processor, logger } = setup({
      base: [stored('s_config', 'src/config.ts', 47)],
      compare: { files: [PUSH_2[0]], ancestor: true },
      resolvedCritical: 1,
    });

    await processor.process(job);

    expect(logger.info).toHaveBeenCalledWith(
      'notification.pull_critical_resolved',
      expect.objectContaining({ resolvedCritical: 1 }),
    );
  });

  it('leaves the resolved notification to the AI step when it runs', async () => {
    const { processor, logger } = setup({
      base: [stored('s_config', 'src/config.ts', 47)],
      compare: { files: [PUSH_2[0]], ancestor: true },
      resolvedCritical: 1,
      aiStatus: AiScanStatus.QUEUED,
    });

    await processor.process(job);

    expect(logger.info).not.toHaveBeenCalledWith(
      'notification.pull_critical_resolved',
      expect.anything(),
    );
  });

  // Acceptance 15: the first scan of a PR behaves as before, all NEW.
  it('marks a first scan FULL and every finding NEW', async () => {
    const { processor, pullsService, written } = setup({});
    pullsService.getDiff.mockResolvedValue({
      files: [
        {
          path: 'src/db.ts',
          previousPath: null,
          status: 'added',
          patch:
            '@@ -0,0 +1,1 @@\n+db.query("SELECT * FROM t WHERE id = " + id);',
        },
      ],
      truncated: false,
    });

    await processor.process(job);

    expect(written.length).toBeGreaterThan(0);
    expect(written.every((r) => r.status === FindingStatus.NEW)).toBe(true);
    expect(written.every((r) => r.firstSeenScanId === 'scan_2')).toBe(true);
  });
});

describe('ScanProcessor — provider errors', () => {
  // MR !1780: GitLab answered merge_base with 400 "Provide at least 2 refs";
  // it was retried and recorded as PROVIDER_UNREACHABLE.
  it('fails a request the provider rejected at once, with its reason', async () => {
    const { processor, pullsService } = setup({
      compare: { files: [], ancestor: true },
    });
    pullsService.getCompareDiff.mockRejectedValue(
      new UnprocessableEntityException({
        field: 'request',
        message: 'provider_bad_request',
        detail: '"Provide at least 2 refs"',
      }),
    );

    const error = await processor.process(job).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ScanFailure);
    expect(error).toMatchObject({
      code: ScanErrorCode.PROVIDER_REJECTED,
      message: 'The code host rejected the request: "Provide at least 2 refs".',
    });
  });

  it('hands an unreachable provider back to BullMQ for a retry', async () => {
    const { processor, pullsService } = setup({
      compare: { files: [], ancestor: true },
    });
    const unreachable = new UnprocessableEntityException({
      field: 'instance_url',
      message: 'instance_unreachable',
    });
    pullsService.getCompareDiff.mockRejectedValue(unreachable);

    await expect(processor.process(job)).rejects.toBe(unreachable);
  });
});

// code.syntax_error: the changed file is read whole and parsed.
describe('ScanProcessor — syntax check', () => {
  const PATH = 'src/total.js';
  const FIXED = [
    'function total(items) {',
    '  if (items.length === 0) {',
    '    return 0;',
    '  }',
    '  return items.length;',
    '}',
    '',
  ].join('\n');
  const BROKEN = FIXED.replace('\n  }\n', '\n  // }\n');
  const SYNTAX_FINGERPRINT = createHash('sha1')
    .update(`code.syntax_error\0${PATH}`)
    .digest('hex');
  const brokenInBase = stored('s_syntax', PATH, 4, {
    ruleId: 'code.syntax_error',
    title: 'Syntax error',
    category: FindingCategory.LOGIC,
    fingerprint: SYNTAX_FINGERPRINT,
  });

  it('flags a commented-out brace as a new critical and notifies', async () => {
    const { processor, pullsService, written, logger } = setup({
      heads: { [PATH]: BROKEN },
    });
    pullsService.getDiff.mockResolvedValue({
      files: [
        {
          path: PATH,
          previousPath: null,
          status: 'modified',
          patch: [
            '@@ -1,6 +1,6 @@',
            ' function total(items) {',
            '   if (items.length === 0) {',
            '     return 0;',
            '-  }',
            '+  // }',
            '   return items.length;',
            ' }',
          ].join('\n'),
        },
      ],
      truncated: false,
    });

    await processor.process(job);

    expect(written).toEqual([
      expect.objectContaining({
        ruleId: 'code.syntax_error',
        source: FindingSource.STATIC,
        severity: FindingSeverity.CRITICAL,
        category: FindingCategory.LOGIC,
        status: FindingStatus.NEW,
        filePath: PATH,
        lineStart: 4,
        suppressedReason: null,
        fingerprint: SYNTAX_FINGERPRINT,
      }),
    ]);
    expect(pullsService.getHeadFileContents).toHaveBeenCalledWith(
      'org_1',
      'repo_1',
      'pull_1',
      'bbb222',
      [PATH],
    );
    expect(logger.warn).toHaveBeenCalledWith(
      'notification.pull_critical_found',
      expect.objectContaining({ criticalCount: 1 }),
    );
  });

  it('suppresses it in a data fixture', async () => {
    const fixture = 'fixtures/broken.json';
    const { processor, pullsService, written } = setup({
      heads: { [fixture]: '{"a": \n' },
    });
    pullsService.getDiff.mockResolvedValue({
      files: [
        {
          path: fixture,
          previousPath: null,
          status: 'added',
          patch: '@@ -0,0 +1 @@\n+{"a": ',
        },
      ],
      truncated: false,
    });

    await processor.process(job);

    expect(written).toEqual([
      expect.objectContaining({
        ruleId: 'code.syntax_error',
        suppressedReason: 'TEST_FILE',
      }),
    ]);
  });

  // The fix adds `}` below the finding's line, which the push did not
  // touch — carried by line, the finding would wrongly stay open.
  it('resolves it when a later push makes the file parse again', async () => {
    const fixedLater = BROKEN.replace('  // }\n', '  // }\n  }\n');
    const { processor, written } = setup({
      base: [brokenInBase],
      compare: {
        files: [
          {
            path: PATH,
            previousPath: null,
            status: 'modified',
            patch: [
              '@@ -3,3 +3,4 @@',
              '     return 0;',
              '   // }',
              '+  }',
              '   return items.length;',
            ].join('\n'),
          },
        ],
        ancestor: true,
      },
      heads: { [PATH]: fixedLater },
    });

    await processor.process(job);

    expect(written).toEqual([
      expect.objectContaining({
        ruleId: 'code.syntax_error',
        status: FindingStatus.RESOLVED,
        originFindingId: 's_syntax',
      }),
    ]);
  });

  it('persists it while a later push leaves the file broken', async () => {
    const { processor, written } = setup({
      base: [brokenInBase],
      compare: {
        files: [
          {
            path: PATH,
            previousPath: null,
            status: 'modified',
            patch: [
              '@@ -2,3 +2,3 @@',
              '   if (items.length === 0) {',
              '-    return 0;',
              '+    return -1;',
              '   // }',
            ].join('\n'),
          },
        ],
        ancestor: true,
      },
      heads: { [PATH]: BROKEN.replace('return 0;', 'return -1;') },
    });

    await processor.process(job);

    expect(written).toEqual([
      expect.objectContaining({
        ruleId: 'code.syntax_error',
        status: FindingStatus.PERSISTED,
        originFindingId: 's_syntax',
        firstSeenScanId: 'scan_1',
      }),
    ]);
  });

  // Undecided: the finding carries by line as before, the scan still ends.
  it('keeps the scan going when the file cannot be fetched', async () => {
    const { processor, pullsService, written, logger } = setup({
      base: [brokenInBase],
      compare: {
        files: [
          {
            path: PATH,
            previousPath: null,
            status: 'modified',
            patch: '@@ -3,1 +3,1 @@\n-    return 0;\n+    return -1;',
          },
        ],
        ancestor: true,
      },
    });
    pullsService.getHeadFileContents.mockRejectedValue(new Error('boom'));

    await processor.process(job);

    expect(logger.warn).toHaveBeenCalledWith(
      'syntax.check_failed',
      expect.objectContaining({ error: 'Error' }),
    );
    expect(written).toEqual([
      expect.objectContaining({
        ruleId: 'code.syntax_error',
        status: FindingStatus.PERSISTED,
      }),
    ]);
  });
});
