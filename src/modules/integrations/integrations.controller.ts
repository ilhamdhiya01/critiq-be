import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { IntegrationsService } from './integrations.service';
import { ConnectGitlabDto } from './dto/connect-gitlab.dto';
import { OrgAuth } from '../../common/decorators/org-auth.decorator';
import { ResponseMessage } from '../../common/decorators/response-message.decorator';
import { Role } from '../../generated/prisma/enums';
import type { JwtPayload } from '../auth/auth.service';

interface RequestWithSession extends Request {
  user: JwtPayload;
}

@Controller('orgs/:orgId/integrations')
export class IntegrationsController {
  constructor(private readonly integrationsService: IntegrationsService) {}

  // Any active member can view integration status (PRD §12.3) — this is
  // read-only, so it doesn't need to be Admin-gated the way connecting or
  // disconnecting does.
  @Get()
  @OrgAuth([])
  @ResponseMessage('Integrations retrieved successfully')
  list(@Param('orgId') orgId: string) {
    return this.integrationsService.list(orgId);
  }

  @Post('gitlab')
  @OrgAuth([Role.ADMIN])
  @ResponseMessage('GitLab integration connected successfully')
  connectGitlab(
    @Param('orgId') orgId: string,
    @Req() req: RequestWithSession,
    @Body() dto: ConnectGitlabDto,
  ) {
    return this.integrationsService.connectGitlab(orgId, req.user.sub, dto);
  }

  @Delete('gitlab')
  @OrgAuth([Role.ADMIN])
  @ResponseMessage('GitLab integration disconnected successfully')
  async disconnectGitlab(@Param('orgId') orgId: string) {
    await this.integrationsService.disconnectGitlab(orgId);
    return null;
  }

  // Admin-only rather than open to all members: this triggers a live call
  // to the GitLab API on demand, and the status it returns is already
  // visible via GET /integrations — no reason to let a Viewer repeatedly
  // trigger outbound calls against GitLab's rate limits for no added value.
  @Get('gitlab/health')
  @OrgAuth([Role.ADMIN])
  @ResponseMessage('GitLab integration health checked successfully')
  getGitlabHealth(@Param('orgId') orgId: string) {
    return this.integrationsService.getHealth(orgId);
  }

  // Connecting a repo is an Admin action per F2 ("Connect Repository" modal,
  // Admin only), so listing what could be connected is gated the same way.
  @Get('gitlab/candidates')
  @OrgAuth([Role.ADMIN])
  @ResponseMessage('GitLab candidates retrieved successfully')
  listGitlabCandidates(
    @Param('orgId') orgId: string,
    @Query('q') query?: string,
  ) {
    return this.integrationsService.listGitlabCandidates(orgId, query);
  }
}
