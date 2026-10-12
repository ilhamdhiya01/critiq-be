import { Controller, Get, Param } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { FindingSeverity } from '../../generated/prisma/enums';

// Per-organization report of pull requests and repositories.
@Controller('orgs/:orgId/pull-report')
export class PullReportController {
  constructor(private readonly prisma: PrismaService) {}

  // Every pull request of the organization with its scan count and its
  // critical findings.
  @Get()
  async report(@Param('orgId') orgId: string) {
    const pulls = await this.prisma.pullRequest.findMany({
      where: { organizationId: orgId },
    });
    const rows: {
      id: string;
      title: string;
      scans: number;
      criticals: number;
    }[] = [];
    for (const pull of pulls) {
      const scans = await this.prisma.scan.findMany({
        where: { pullId: pull.id },
      });
      const criticals = await this.prisma.finding.count({
        where: { pullId: pull.id, severity: FindingSeverity.CRITICAL },
      });
      rows.push({
        id: pull.id,
        title: pull.title,
        scans: scans.length,
        criticals,
      });
    }
    return rows;
  }

  // Star count of every repository of the organization, read from GitHub.
  @Get('repos-status')
  async reposStatus(@Param('orgId') orgId: string) {
    const repositories = await this.prisma.repository.findMany({
      where: { organizationId: orgId },
    });
    return Promise.all(
      repositories.map(async (repository) => {
        const response = await fetch(
          `https://api.github.com/repos/${repository.path}`,
        );
        const data = (await response.json()) as { stargazers_count?: number };
        return { id: repository.id, stars: data.stargazers_count ?? 0 };
      }),
    );
  }

  // The 50 most recently updated pull requests with their critical
  // findings, counted in one grouped query.
  @Get('recent')
  async recent(@Param('orgId') orgId: string) {
    const pulls = await this.prisma.pullRequest.findMany({
      where: { organizationId: orgId },
      orderBy: { updatedAt: 'desc' },
      take: 50,
    });
    const counts = await this.prisma.finding.groupBy({
      by: ['pullId'],
      where: {
        pullId: { in: pulls.map((pull) => pull.id) },
        severity: FindingSeverity.CRITICAL,
      },
      _count: { _all: true },
    });
    const criticalsByPull = new Map(
      counts.map((count) => [count.pullId, count._count._all]),
    );
    return pulls.map((pull) => ({
      id: pull.id,
      title: pull.title,
      criticals: criticalsByPull.get(pull.id) ?? 0,
    }));
  }
}
