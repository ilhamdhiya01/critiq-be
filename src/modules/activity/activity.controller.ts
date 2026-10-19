import { Controller, Get, Param, Query } from '@nestjs/common';
import { OrgAuth } from '../../common/decorators/org-auth.decorator';
import { ResponseMessage } from '../../common/decorators/response-message.decorator';
import { ActivityService } from './activity.service';
import { ActivityQueryDto } from './dto/activity-query.dto';

// The Activity menu — read-only, every role.
@Controller('orgs/:orgId/activity')
export class ActivityController {
  constructor(private readonly activityService: ActivityService) {}

  @Get()
  @OrgAuth([])
  @ResponseMessage('Activity retrieved successfully')
  list(@Param('orgId') orgId: string, @Query() query: ActivityQueryDto) {
    return this.activityService.list(orgId, query);
  }
}
