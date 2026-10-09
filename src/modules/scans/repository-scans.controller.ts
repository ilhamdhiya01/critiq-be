import { Controller, Get, Param, Query } from '@nestjs/common';
import { OrgAuth } from '../../common/decorators/org-auth.decorator';
import { ResponseMessage } from '../../common/decorators/response-message.decorator';
import { RepositoryScansQueryDto } from './dto/repository-scans-query.dto';
import { ScansService } from './scans.service';

// A repository's scan history across its PRs — the repo page's "PR Scan
// History". Nested under the repo like PullsController.
@Controller('orgs/:orgId/repos/:repoId/scans')
export class RepositoryScansController {
  constructor(private readonly scansService: ScansService) {}

  @Get()
  @OrgAuth([])
  @ResponseMessage('Repository scans retrieved successfully')
  list(
    @Param('orgId') orgId: string,
    @Param('repoId') repoId: string,
    @Query() query: RepositoryScansQueryDto,
  ) {
    return this.scansService.listForRepository(orgId, repoId, query.limit);
  }
}
