import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { PullRequestState, RuleTier } from '../../generated/prisma/enums';
import { ALL_RULE_TIERS, tierForRule } from '../../queue/rules/rule-tiers';
import { RULES } from '../../queue/rules/rules';
import { SYNTAX_RULE_ID } from '../../queue/rules/syntax/syntax-check';
import { toApiRuleTier } from '../scans/dto/ai-scan-fields';
import {
  DEFAULT_SEARCH_LIMIT,
  SearchResultsDto,
  SearchRuleDto,
} from './dto/search.dto';

const TIER_LABELS: Record<RuleTier, string> = {
  SECRETS: 'Secrets',
  CRASH: 'Crash',
  BREAKING_CHANGE: 'Breaking change',
  ERROR_HANDLING: 'Error handling',
  PERFORMANCE: 'Performance',
  SECURITY: 'Security',
};

// What the Rules page lists: its tiers, then the static rules in each.
const RULE_CATALOG: SearchRuleDto[] = [
  ...ALL_RULE_TIERS.map((tier): SearchRuleDto => ({
    kind: 'tier',
    id: toApiRuleTier(tier),
    label: TIER_LABELS[tier],
    tier: toApiRuleTier(tier),
  })),
  ...[
    ...RULES.map((rule) => ({ id: rule.id, title: rule.title })),
    { id: SYNTAX_RULE_ID, title: 'Syntax error' },
  ].flatMap((rule): SearchRuleDto[] => {
    const tier = tierForRule(rule.id);
    return tier
      ? [
          {
            kind: 'rule',
            id: rule.id,
            label: rule.title,
            tier: toApiRuleTier(tier),
          },
        ]
      : [];
  }),
];

// `482` or `#482`: also a PR number.
const PR_NUMBER = /^#?(\d{1,10})$/;

// Prisma's `contains` becomes ILIKE '%…%' without escaping: a `%` or `_`
// typed by the user would match everything. Backslash is Postgres' default
// LIKE escape.
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

// The ⌘K palette (CLAUDE.md "Search"): repositories, pull requests and
// rules of one organization matching the text. PAGES are the FE's own.
@Injectable()
export class SearchService {
  constructor(private readonly prisma: PrismaService) {}

  async search(
    organizationId: string,
    query: string,
    limit = DEFAULT_SEARCH_LIMIT,
  ): Promise<SearchResultsDto> {
    const q = query.trim();
    const text = { contains: escapeLike(q), mode: 'insensitive' as const };
    const number = PR_NUMBER.exec(q)?.[1];

    const [repositories, pulls] = await Promise.all([
      this.prisma.repository.findMany({
        where: { organizationId, path: text },
        orderBy: { path: 'asc' },
        take: limit,
        select: { id: true, path: true, language: true },
      }),
      this.prisma.pullRequest.findMany({
        where: {
          organizationId,
          OR: [
            { title: text },
            { sourceBranch: text },
            { authorUsername: text },
            ...(number ? [{ externalId: number }] : []),
          ],
        },
        // The enum is declared OPEN, CLOSED, MERGED: open ones first.
        orderBy: [{ state: 'asc' }, { updatedAt: 'desc' }],
        take: limit,
        select: {
          id: true,
          repositoryId: true,
          externalId: true,
          title: true,
          state: true,
          updatedAt: true,
          repository: { select: { path: true } },
        },
      }),
    ]);
    const openCritical = await this.openCriticalByRepository(
      organizationId,
      repositories.map((repository) => repository.id),
    );

    const needle = q.toLowerCase();
    return new SearchResultsDto({
      repositories: repositories.map((repository) => ({
        ...repository,
        openCriticalCount: openCritical.get(repository.id) ?? 0,
      })),
      pulls: pulls.map((pull) => ({
        id: pull.id,
        repoId: pull.repositoryId,
        repoPath: pull.repository.path,
        number: pull.externalId,
        title: pull.title,
        state: pull.state.toLowerCase() as 'open' | 'closed' | 'merged',
        updatedAt: pull.updatedAt,
      })),
      rules: RULE_CATALOG.filter(
        (rule) =>
          rule.label.toLowerCase().includes(needle) || rule.id.includes(needle),
      ).slice(0, limit),
    });
  }

  // The same figure GET …/repos shows (ReposService.repositoryStats): the
  // latest scan's active criticals over the repo's open PRs. Only for the
  // repositories matched.
  private async openCriticalByRepository(
    organizationId: string,
    repositoryIds: string[],
  ): Promise<Map<string, number>> {
    const totals = new Map<string, number>();
    if (repositoryIds.length === 0) {
      return totals;
    }
    const openPulls = await this.prisma.pullRequest.findMany({
      where: {
        organizationId,
        repositoryId: { in: repositoryIds },
        state: PullRequestState.OPEN,
      },
      select: {
        repositoryId: true,
        latestScan: { select: { criticalCount: true } },
      },
    });
    for (const pull of openPulls) {
      totals.set(
        pull.repositoryId,
        (totals.get(pull.repositoryId) ?? 0) +
          (pull.latestScan?.criticalCount ?? 0),
      );
    }
    return totals;
  }
}
