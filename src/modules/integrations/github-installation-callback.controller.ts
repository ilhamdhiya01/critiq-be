import { Controller, Get, Query, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { IntegrationsService } from './integrations.service';
import { GithubAppService } from './github-app.service';
import { GithubInstallIntentService } from './github-install-intent.service';
import { GithubInstallCallbackDto } from './dto/github-install-callback.dto';
import { GithubInstallReturnTo } from '../../generated/prisma/enums';

// Global route (no :orgId in the path — GitHub's fixed Setup URL, configured
// once when the App was registered, cannot template an org id into it) and
// deliberately unguarded: GitHub's server is the caller here, not the
// admin's browser, so there is no session cookie on this request at all —
// @OrgAuth/OrgRolesGuard (which hard-requires request.params.orgId) and
// AuthGuard('jwt') both structurally cannot apply. Org/user context is
// recovered from the single-use GithubInstallIntent row instead, which was
// only ever creatable by an already-@OrgAuth([Role.ADMIN])-gated call to
// IntegrationsController.createGithubInstallIntent — the authorization
// already happened there; this endpoint just completes a flow that started
// under guard.
//
// Effective external path (global prefix `api/v1` from main.ts still
// applies to this route): /api/v1/github/installations/callback — this
// must match exactly what's configured as the GitHub App's Setup URL.
@Controller('github/installations')
export class GithubInstallationCallbackController {
  constructor(
    private readonly integrationsService: IntegrationsService,
    private readonly githubAppService: GithubAppService,
    private readonly githubInstallIntentService: GithubInstallIntentService,
    private readonly configService: ConfigService,
  ) {}

  @Get('callback')
  async callback(
    @Query() query: GithubInstallCallbackDto,
    @Res() res: Response,
  ): Promise<void> {
    const feUrl = this.configService.getOrThrow<string>('feUrl');

    const intent = await this.githubInstallIntentService.consume(query.state);
    if (!intent) {
      // No valid intent (missing, already consumed, or expired). This also
      // covers the case where the admin installed the App directly from
      // GitHub's Marketplace/App page rather than via Critiq's own "Connect
      // GitHub" button — there was never an intent to look up in the first
      // place. Either way, Critiq doesn't yet know which organization this
      // installation belongs to, so hand off to an FE flow that asks the
      // user to pick one, rather than silently failing.
      res.redirect(
        `${feUrl}/integrations/github/claim?installation_id=${encodeURIComponent(query.installation_id)}`,
      );
      return;
    }
    const { orgId, userId, returnTo } = intent;
    const redirectBase =
      returnTo === GithubInstallReturnTo.SETUP
        ? `${feUrl}/setup?step=2&orgId=${orgId}`
        : `${feUrl}/orgs/${orgId}/settings/integrations`;
    const separator = redirectBase.includes('?') ? '&' : '?';

    try {
      const installation = await this.githubAppService.verifyInstallation(
        query.installation_id,
      );
      await this.integrationsService.connectGithub(
        orgId,
        userId,
        installation,
        query.setup_action,
      );

      const statusParam =
        query.setup_action === 'request'
          ? 'github=pending_approval'
          : 'github=connected';
      res.redirect(`${redirectBase}${separator}${statusParam}`);
    } catch {
      // Covers both verifyInstallation failures (installation_invalid /
      // github_unreachable) and connectGithub's ConflictException
      // (installation_in_use) — browser-navigated request, nothing on this
      // leg of the flow can read a JSON error body, so redirect with a
      // reason code rather than throw.
      res.redirect(`${redirectBase}${separator}github=error`);
    }
  }
}
