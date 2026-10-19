import { Controller, Get, Param, Query } from '@nestjs/common';
import { OrgAuth } from '../../common/decorators/org-auth.decorator';
import { ResponseMessage } from '../../common/decorators/response-message.decorator';
import { DashboardService } from './dashboard.service';
import { DashboardLimitQueryDto } from './dto/dashboard-limit-query.dto';

// The Dashboard menu — read-only, every role.
@Controller('orgs/:orgId/dashboard')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get('summary')
  @OrgAuth([])
  @ResponseMessage('Dashboard summary retrieved successfully')
  summary(@Param('orgId') orgId: string) {
    return this.dashboardService.summary(orgId);
  }

  @Get('critical-issues')
  @OrgAuth([])
  @ResponseMessage('Critical issues retrieved successfully')
  criticalIssues(
    @Param('orgId') orgId: string,
    @Query() query: DashboardLimitQueryDto,
  ) {
    return this.dashboardService.criticalIssues(orgId, query.limit);
  }

  @Get('recent-reviews')
  @OrgAuth([])
  @ResponseMessage('Recent reviews retrieved successfully')
  recentReviews(
    @Param('orgId') orgId: string,
    @Query() query: DashboardLimitQueryDto,
  ) {
    return this.dashboardService.recentReviews(orgId, query.limit);
  }
}
