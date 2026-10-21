import { Controller, Get, Param, Query } from '@nestjs/common';
import { OrgAuth } from '../../common/decorators/org-auth.decorator';
import { ResponseMessage } from '../../common/decorators/response-message.decorator';
import { InsightsQueryDto } from './dto/insights.dto';
import { InsightsService } from './insights.service';

// The Insights menu — read-only, every role.
@Controller('orgs/:orgId/insights')
export class InsightsController {
  constructor(private readonly insightsService: InsightsService) {}

  @Get()
  @OrgAuth([])
  @ResponseMessage('Insights retrieved successfully')
  overview(@Param('orgId') orgId: string, @Query() query: InsightsQueryDto) {
    return this.insightsService.overview(orgId, query.weeks);
  }
}
