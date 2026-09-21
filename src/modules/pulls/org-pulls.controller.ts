import { Controller, Get, Param } from '@nestjs/common';
import { PullsService } from './pulls.service';
import { OrgAuth } from '../../common/decorators/org-auth.decorator';
import { ResponseMessage } from '../../common/decorators/response-message.decorator';

// Separate controller (not folded into PullsController) purely because its
// URL prefix is `orgs/:orgId/pulls` — no `:repoId` — listing PRs across
// every repo in the org for a dashboard-style view. PullsService stays the
// single owner of all pull request query logic either way.
@Controller('orgs/:orgId/pulls')
export class OrgPullsController {
  constructor(private readonly pullsService: PullsService) {}

  @Get()
  @OrgAuth([])
  @ResponseMessage('Pull requests retrieved successfully')
  list(@Param('orgId') orgId: string) {
    return this.pullsService.listForOrganization(orgId);
  }
}
