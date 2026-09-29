import { Controller, Get, Header, Param, Query } from '@nestjs/common';
import { OrgAuth } from '../../common/decorators/org-auth.decorator';
import { ResponseMessage } from '../../common/decorators/response-message.decorator';
import { ListFindingsQueryDto } from './dto/list-findings-query.dto';
import { ScansService } from './scans.service';

// Scans are addressed by id alone under the org — the FE polls a scan it got
// back from POST …/pulls/:id/scans without having to carry the repo and PR
// ids along. The per-PR routes (history, rescan) live on PullsController.
@Controller('orgs/:orgId/scans')
export class ScansController {
  constructor(private readonly scansService: ScansService) {}

  // Polled while a scan runs; a cached response would freeze the progress bar.
  @Get(':scanId')
  @OrgAuth([])
  @Header('Cache-Control', 'no-store')
  @ResponseMessage('Scan retrieved successfully')
  getScan(@Param('orgId') orgId: string, @Param('scanId') scanId: string) {
    return this.scansService.getScan(orgId, scanId);
  }

  @Get(':scanId/findings')
  @OrgAuth([])
  @ResponseMessage('Findings retrieved successfully')
  listFindings(
    @Param('orgId') orgId: string,
    @Param('scanId') scanId: string,
    @Query() query: ListFindingsQueryDto,
  ) {
    return this.scansService.listFindings(
      orgId,
      scanId,
      query.includeSuppressed !== 'false',
      query.status ?? 'active',
    );
  }
}
