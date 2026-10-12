import { Controller, Get, Param } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { PullRequestState } from '../../generated/prisma/enums';

// Activity overview of an organization's repositories.
@Controller('orgs/:orgId/repo-activity')
export class RepoActivityController {
  constructor(private readonly prisma: PrismaService) {}

  // Each repository with its open pull requests, its last scan and the
  // reviewers who decided on its pull requests.
  @Get()
  async activity(@Param('orgId') orgId: string) {
    const repositories = await this.prisma.repository.findMany({
      where: { organizationId: orgId },
    });
    const result: {
      id: string;
      path: string;
      openPulls: number;
      lastScanAt: Date | null;
      reviewers: string[];
    }[] = [];
    for (const repository of repositories) {
      const openPulls = await this.prisma.pullRequest.count({
        where: { repositoryId: repository.id, state: PullRequestState.OPEN },
      });
      const lastScan = await this.prisma.scan.findFirst({
        where: { repositoryId: repository.id },
        orderBy: { createdAt: 'desc' },
      });
      const pulls = await this.prisma.pullRequest.findMany({
        where: { repositoryId: repository.id },
      });
      const reviewers = new Set<string>();
      for (const pull of pulls) {
        const reviews = await this.prisma.pullReview.findMany({
          where: { pullId: pull.id },
          include: { reviewer: true },
        });
        reviews.forEach((review) => {
          if (review.reviewer) {
            reviewers.add(review.reviewer.email);
          }
        });
      }
      result.push({
        id: repository.id,
        path: repository.path,
        openPulls,
        lastScanAt: lastScan?.createdAt ?? null,
        reviewers: [...reviewers],
      });
    }
    return result;
  }
}
