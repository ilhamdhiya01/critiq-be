import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  FindingSeverity,
  FindingSource,
  FindingStatus,
} from '../../generated/prisma/enums';
import { RULES } from '../../queue/rules/rules';
import { SYNTAX_RULE_ID } from '../../queue/rules/syntax/syntax-check';
import {
  DEFAULT_WEEKS,
  InsightsDto,
  InsightsRuleDto,
  InsightsWeekDto,
} from './dto/insights.dto';

const DAY_MS = 86_400_000;
const TOP_RULES = 5;

const RULE_LABELS = new Map<string, string>([
  ...RULES.map((rule): [string, string] => [rule.id, rule.title]),
  [SYNTAX_RULE_ID, 'Syntax error'],
]);

// "ai.breaking_change" → "AI · Breaking change".
export function ruleLabel(ruleId: string): string {
  const known = RULE_LABELS.get(ruleId);
  if (known) {
    return known;
  }
  if (ruleId.startsWith('ai.')) {
    const words = ruleId.slice(3).replace(/_/g, ' ');
    return `AI · ${words.charAt(0).toUpperCase()}${words.slice(1)}`;
  }
  return ruleId;
}

// Monday 00:00 UTC of the ISO week holding `date`.
export function isoWeekStart(date: Date): Date {
  const daysSinceMonday = (date.getUTCDay() + 6) % 7;
  return new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate() - daysSinceMonday,
    ),
  );
}

const ymd = (date: Date) => date.toISOString().slice(0, 10);

const roundHours = (seconds: number | null) =>
  seconds === null ? null : Math.round((seconds / 3600) * 10) / 10;

// A critical appearing: first found, or back after being resolved. Finding
// rows are copied scan to scan (PERSISTED), so counting every row would
// count one issue once per push.
const FOUND = {
  severity: FindingSeverity.CRITICAL,
  suppressedReason: null,
  status: { in: [FindingStatus.NEW, FindingStatus.REOPENED] },
};

// The Insights menu (CLAUDE.md "Insights"): read-only aggregates of one
// organization's critical findings, from the database only.
@Injectable()
export class InsightsService {
  constructor(private readonly prisma: PrismaService) {}

  async overview(
    organizationId: string,
    weeks = DEFAULT_WEEKS,
    now: Date = new Date(),
  ): Promise<InsightsDto> {
    const monthAgo = new Date(now.getTime() - 30 * DAY_MS);
    const twoMonthsAgo = new Date(now.getTime() - 60 * DAY_MS);
    const firstWeek = new Date(
      isoWeekStart(now).getTime() - (weeks - 1) * 7 * DAY_MS,
    );

    const [last30d, previous30d, weeklyRows, resolveRows, ruleGroups] =
      await Promise.all([
        this.prisma.finding.count({
          where: {
            organizationId,
            ...FOUND,
            createdAt: { gte: monthAgo, lt: now },
          },
        }),
        this.prisma.finding.count({
          where: {
            organizationId,
            ...FOUND,
            createdAt: { gte: twoMonthsAgo, lt: monthAgo },
          },
        }),
        this.prisma.$queryRaw<
          Array<{ week: string; source: FindingSource; count: number }>
        >`
          SELECT to_char(date_trunc('week', "createdAt"), 'YYYY-MM-DD') AS week,
                 source::text AS source,
                 count(*)::int AS count
            FROM "findings"
           WHERE "organizationId" = ${organizationId}
             AND severity = 'CRITICAL'
             AND "suppressedReason" IS NULL
             AND status IN ('NEW', 'REOPENED')
             AND "createdAt" >= ${firstWeek}
           GROUP BY 1, 2`,
        // How many resolved, and how long after the scan that first found
        // them.
        this.prisma.$queryRaw<
          Array<{ recent: boolean; resolved: number; seconds: number }>
        >`
          SELECT f."createdAt" >= ${monthAgo} AS recent,
                 count(*)::int AS resolved,
                 avg(extract(epoch FROM f."createdAt" - s."createdAt"))::float8 AS seconds
            FROM "findings" f
            JOIN "scans" s ON s.id = f."firstSeenScanId"
            JOIN "scans" rs ON rs.id = f."scanId"
            LEFT JOIN "scans" b ON b.id = rs."baseScanId"
           WHERE f."organizationId" = ${organizationId}
             AND f.severity = 'CRITICAL'
             AND f."suppressedReason" IS NULL
             AND f.status = 'RESOLVED'
             -- The code changed. A rescan of the same commit by another AI
             -- model also resolves what that model did not repeat: models
             -- disagreeing, nothing fixed.
             AND (b.id IS NULL OR rs."headSha" <> b."headSha")
             AND f."createdAt" >= ${twoMonthsAgo}
             AND f."createdAt" < ${now}
           GROUP BY 1`,
        this.prisma.finding.groupBy({
          by: ['ruleId', 'source'],
          where: {
            organizationId,
            ...FOUND,
            createdAt: { gte: monthAgo, lt: now },
          },
          _count: { _all: true },
          orderBy: [{ _count: { ruleId: 'desc' } }, { ruleId: 'asc' }],
          take: TOP_RULES,
        }),
      ]);

    const weekly: InsightsWeekDto[] = Array.from(
      { length: weeks },
      (_, index) => ({
        weekStart: ymd(new Date(firstWeek.getTime() + index * 7 * DAY_MS)),
        static: 0,
        ai: 0,
      }),
    );
    for (const row of weeklyRows) {
      const week = weekly.find((entry) => entry.weekStart === row.week);
      if (week) {
        week[row.source === FindingSource.AI ? 'ai' : 'static'] += row.count;
      }
    }
    const resolvedIn = (recent: boolean) =>
      resolveRows.find((row) => row.recent === recent);

    return new InsightsDto({
      criticalFound: { last30d, previous30d },
      criticalResolved: {
        last30d: resolvedIn(true)?.resolved ?? 0,
        previous30d: resolvedIn(false)?.resolved ?? 0,
      },
      meanTimeToResolveHours: {
        last30d: roundHours(resolvedIn(true)?.seconds ?? null),
        previous30d: roundHours(resolvedIn(false)?.seconds ?? null),
      },
      weekly,
      topRules: ruleGroups.map((group): InsightsRuleDto => ({
        ruleId: group.ruleId,
        label: ruleLabel(group.ruleId),
        source: group.source,
        count: group._count._all,
      })),
    });
  }
}
