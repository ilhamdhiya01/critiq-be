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
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { IntegrationsService } from './integrations.service';
import { ConnectGitlabDto } from './dto/connect-gitlab.dto';
import { GithubInstallIntentDto } from './dto/github-install-intent.dto';
import { GithubInstallIntentResponseDto } from './dto/github-install-intent-response.dto';
import { GithubInstallIntentService } from './github-install-intent.service';
import { OrgAuth } from '../../common/decorators/org-auth.decorator';
import { ResponseMessage } from '../../common/decorators/response-message.decorator';
import { GithubInstallReturnTo, Role } from '../../generated/prisma/enums';
import type { JwtPayload } from '../auth/auth.service';

interface RequestWithSession extends Request {
  user: JwtPayload;
}

@Controller('orgs/:orgId/integrations')
export class IntegrationsController {
  constructor(
    private readonly integrationsService: IntegrationsService,
    private readonly githubInstallIntentService: GithubInstallIntentService,
    private readonly configService: ConfigService,
  ) {}

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

  // Returns a URL for the FE to navigate the browser to — not a
  // server-side redirect. This route needs OrgRolesGuard to run as a
  // normal authenticated API call first (Admin-only, org-scoped); a bare
  // browser-navigated link here would either drop credentials or render a
  // raw JSON 403 in the tab on failure instead of something the FE's own
  // error handling can catch. The FE calls this, gets `installUrl`, then
  // does `window.location.href = installUrl` itself — mirroring how the
  // existing GitHub/GitLab login buttons already navigate the browser
  // themselves rather than being redirected to by Critiq.
  //
  // POST, not GET: this has a real side effect (a GithubInstallIntent row
  // is created), matching connectGitlab's verb choice for the same reason.
  // `returnTo` lets the same install flow be entered from two different FE
  // contexts (onboarding wizard vs. Settings) and have the eventual GitHub
  // callback send the browser back to the right one — see
  // GithubInstallationCallbackController.
  @Post('github/install-intent')
  @OrgAuth([Role.ADMIN])
  @ResponseMessage('GitHub install URL generated successfully')
  async createGithubInstallIntent(
    @Param('orgId') orgId: string,
    @Req() req: RequestWithSession,
    @Body() dto: GithubInstallIntentDto,
  ) {
    const returnTo =
      dto.returnTo === 'setup'
        ? GithubInstallReturnTo.SETUP
        : GithubInstallReturnTo.SETTINGS;
    const { state } = await this.githubInstallIntentService.create({
      orgId,
      userId: req.user.sub,
      returnTo,
    });
    const slug = this.configService.getOrThrow<string>('githubApp.slug');
    const installUrl = `https://github.com/apps/${slug}/installations/new?state=${encodeURIComponent(state)}`;
    return new GithubInstallIntentResponseDto({ installUrl });
  }

  // Connecting a repo is an Admin action, same gating rationale as
  // GitLab's candidates route above.
  @Get('github/candidates')
  @OrgAuth([Role.ADMIN])
  @ResponseMessage('GitHub candidates retrieved successfully')
  listGithubCandidates(
    @Param('orgId') orgId: string,
    @Query('q') query?: string,
  ) {
    return this.integrationsService.listGithubCandidates(orgId, query);
  }
}
