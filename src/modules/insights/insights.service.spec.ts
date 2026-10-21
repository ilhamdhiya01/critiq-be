import { PrismaService } from '../../common/prisma/prisma.service';
import {
  FindingSeverity,
  FindingSource,
  FindingStatus,
} from '../../generated/prisma/enums';
import { InsightsService, isoWeekStart, ruleLabel } from './insights.service';

jest.mock('../../common/prisma/prisma.service', () => ({
  PrismaService: class {},
}));

const ORG = 'org_1';
// A Wednesday.
const NOW = new Date('2026-10-21T12:00:00Z');

function setup() {
  const prisma = {
    finding: {
      count: jest.fn().mockResolvedValue(0),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    $queryRaw: jest.fn().mockResolvedValue([]),
  };
  const service = new InsightsService(prisma as unknown as PrismaService);
  return { service, prisma };
}

describe('isoWeekStart', () => {
  it.each([
    ['2026-10-21T12:00:00Z', '2026-10-19'], // Wednesday
    ['2026-10-19T00:00:00Z', '2026-10-19'], // Monday
    ['2026-10-25T23:59:00Z', '2026-10-19'], // Sunday
  ])('%s → %s', (date, monday) => {
    expect(isoWeekStart(new Date(date)).toISOString().slice(0, 10)).toBe(
      monday,
    );
  });
});

describe('ruleLabel', () => {
  it.each([
    ['code.syntax_error', 'Syntax error'],
    ['ai.breaking_change', 'AI · Breaking change'],
    ['ai.performance', 'AI · Performance'],
    ['custom.unknown', 'custom.unknown'],
  ])('%s → %s', (ruleId, label) => {
    expect(ruleLabel(ruleId)).toBe(label);
  });

  it('uses the static rule title', () => {
    expect(ruleLabel('code.debugger_left')).toBe(
      'Debugger breakpoint left in code',
    );
  });
});

describe('InsightsService.overview', () => {
  // Rows are copied scan to scan: only appearances count.
  it('counts active critical appearances, 30 days against the 30 before', async () => {
    const { service, prisma } = setup();
    prisma.finding.count.mockResolvedValueOnce(12).mockResolvedValueOnce(20);
    const insights = await service.overview(ORG, 8, NOW);
    expect(insights.criticalFound).toEqual({ last30d: 12, previous30d: 20 });
    const [{ where }] = prisma.finding.count.mock.calls[0] as [
      { where: Record<string, unknown> },
    ];
    expect(where).toEqual({
      organizationId: ORG,
      severity: FindingSeverity.CRITICAL,
      suppressedReason: null,
      status: { in: [FindingStatus.NEW, FindingStatus.REOPENED] },
      createdAt: {
        gte: new Date('2026-09-21T12:00:00Z'),
        lt: NOW,
      },
    });
  });

  it('fills every week, oldest first, splitting static and AI', async () => {
    const { service, prisma } = setup();
    prisma.$queryRaw.mockResolvedValueOnce([
      { week: '2026-10-19', source: FindingSource.STATIC, count: 3 },
      { week: '2026-10-19', source: FindingSource.AI, count: 2 },
      { week: '2026-09-28', source: FindingSource.STATIC, count: 1 },
    ]);
    const { weekly } = await service.overview(ORG, 4, NOW);
    expect(weekly).toEqual([
      { weekStart: '2026-09-28', static: 1, ai: 0 },
      { weekStart: '2026-10-05', static: 0, ai: 0 },
      { weekStart: '2026-10-12', static: 0, ai: 0 },
      { weekStart: '2026-10-19', static: 3, ai: 2 },
    ]);
  });

  it('counts resolutions and averages time to resolve, per window', async () => {
    const { service, prisma } = setup();
    prisma.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { recent: true, resolved: 9, seconds: 43_200 + 360 },
      ]);
    const insights = await service.overview(ORG, 8, NOW);
    expect(insights.criticalResolved).toEqual({ last30d: 9, previous30d: 0 });
    expect(insights.meanTimeToResolveHours).toEqual({
      last30d: 12.1,
      previous30d: null,
    });
  });

  it('labels the top rules, most frequent first', async () => {
    const { service, prisma } = setup();
    prisma.finding.groupBy.mockResolvedValue([
      {
        ruleId: 'code.debugger_left',
        source: FindingSource.STATIC,
        _count: { _all: 4 },
      },
      {
        ruleId: 'ai.performance',
        source: FindingSource.AI,
        _count: { _all: 2 },
      },
    ]);
    const { topRules } = await service.overview(ORG, 8, NOW);
    expect(topRules).toEqual([
      {
        ruleId: 'code.debugger_left',
        label: 'Debugger breakpoint left in code',
        source: FindingSource.STATIC,
        count: 4,
      },
      {
        ruleId: 'ai.performance',
        label: 'AI · Performance',
        source: FindingSource.AI,
        count: 2,
      },
    ]);
    expect(prisma.finding.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ take: 5 }),
    );
  });

  // Swapping the AI model and rescanning the same commit is not a fix.
  it('counts a resolution only when the code changed', async () => {
    const { service, prisma } = setup();
    await service.overview(ORG, 8, NOW);
    const [strings] = prisma.$queryRaw.mock.calls[1] as [TemplateStringsArray];
    expect(strings.join('?')).toContain('rs."headSha" <> b."headSha"');
  });

  // Tenant isolation: the raw queries are parameterized by the org.
  it('scopes the raw queries to the organization', async () => {
    const { service, prisma } = setup();
    await service.overview(ORG, 8, NOW);
    for (const call of prisma.$queryRaw.mock.calls as [
      TemplateStringsArray,
      ...unknown[],
    ][]) {
      const [strings, ...params] = call;
      expect(strings.join('?')).toContain('"organizationId" = ?');
      expect(params).toContain(ORG);
    }
  });
});
