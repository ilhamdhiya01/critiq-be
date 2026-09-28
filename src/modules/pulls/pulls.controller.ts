import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { PullsService } from './pulls.service';
import { ScansService } from '../scans/scans.service';
import { OrgAuth } from '../../common/decorators/org-auth.decorator';
import { ResponseMessage } from '../../common/decorators/response-message.decorator';
import { Role } from '../../generated/prisma/enums';
import type { JwtPayload } from '../auth/auth.service';

interface RequestWithSession extends Request {
  user: JwtPayload;
}

@Controller('orgs/:orgId/repos/:repoId/pulls')
export class PullsController {
  constructor(
    private readonly pullsService: PullsService,
    private readonly scansService: ScansService,
  ) {}

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

  @Get(':id/scans')
  @OrgAuth([])
  @ResponseMessage('Scans retrieved successfully')
  listScans(
    @Param('orgId') orgId: string,
    @Param('repoId') repoId: string,
    @Param('id') id: string,
  ) {
    return this.scansService.listForPull(orgId, repoId, id);
  }

  // Viewer is read-only (403 from OrgRolesGuard). 202: the scan is only
  // queued — poll GET orgs/:orgId/scans/:scanId for the result.
  @Post(':id/scans')
  @OrgAuth([Role.ADMIN, Role.REVIEWER])
  @HttpCode(HttpStatus.ACCEPTED)
  @ResponseMessage('Scan requested')
  requestScan(
    @Req() req: RequestWithSession,
    @Param('orgId') orgId: string,
    @Param('repoId') repoId: string,
    @Param('id') id: string,
  ) {
    return this.scansService.requestRescan(orgId, repoId, id, req.user.sub);
  }
}
