import { Controller, Get, Param } from '@nestjs/common';
import { PullsService } from './pulls.service';
import { OrgAuth } from '../../common/decorators/org-auth.decorator';
import { ResponseMessage } from '../../common/decorators/response-message.decorator';

@Controller('orgs/:orgId/repos/:repoId/pulls')
export class PullsController {
  constructor(private readonly pullsService: PullsService) {}

  @Get()
  @OrgAuth([])
  @ResponseMessage('Pull requests retrieved successfully')
  list(@Param('orgId') orgId: string, @Param('repoId') repoId: string) {
    return this.pullsService.list(orgId, repoId);
  }

  @Get(':id')
  @OrgAuth([])
  @ResponseMessage('Pull request retrieved successfully')
  getDetail(
    @Param('orgId') orgId: string,
    @Param('repoId') repoId: string,
    @Param('id') id: string,
  ) {
    return this.pullsService.getDetail(orgId, repoId, id);
  }

  @Get(':id/diff')
  @OrgAuth([])
  @ResponseMessage('Pull request diff retrieved successfully')
  getDiff(
    @Param('orgId') orgId: string,
    @Param('repoId') repoId: string,
    @Param('id') id: string,
  ) {
    return this.pullsService.getDiff(orgId, repoId, id);
  }
}
