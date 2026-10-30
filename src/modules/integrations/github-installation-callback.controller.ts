import { Controller, Get, Query, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { IntegrationsService } from './integrations.service';
import { GithubAppService } from './github-app.service';
import { GithubInstallIntentService } from './github-install-intent.service';
import {
  GithubAuthorizeCallbackDto,
  GithubInstallCallbackDto,
} from './dto/github-install-callback.dto';
import { GithubInstallVerificationService } from './github-install-verification.service';
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
    private readonly verificationService: GithubInstallVerificationService,
    private readonly configService: ConfigService,
  ) {}

  @Get('callback')
  async callback(
    @Query() query: GithubInstallCallbackDto,
    @Res() res: Response,
  ): Promise<void> {
    const feUrl = this.configService.getOrThrow<string>('feUrl');

    // No `state` at all — e.g. the admin changed an existing installation's
    // granted repos from GitHub's own UI (github.com/settings/installations)
    // rather than starting from Critiq's "Connect GitHub" button. GitHub
    // still hits this Setup URL ("Redirect on update"), but never had a
    // Critiq-issued `state` to echo back, since no installations/new?state=
    // link was ever visited for that trip — there's nothing to consume.
    const intent = query.state
      ? await this.githubInstallIntentService.consume(query.state)
      : null;
    if (!intent) {
      // An installation Critiq already holds, changed on GitHub ("Manage on
      // GitHub" → repository access): back to that org's Settings. Nothing
      // is written — this request carries no session, and the granted repos
      // are read live from GitHub (candidates). The slug is the only thing
      // this reveals for a known installation id, and it is in every FE URL
      // of that org anyway.
      if (query.setup_action === 'update' && query.installation_id) {
        const slug =
          await this.integrationsService.findOrgSlugForGithubInstallation(
            query.installation_id,
          );
        if (slug) {
          res.redirect(
            `${feUrl}/${encodeURIComponent(slug)}/settings?github=updated`,
          );
          return;
        }
      }
      // No valid intent (missing, already consumed, or expired) for an
      // installation Critiq does not know — e.g. the admin installed the
      // App directly from GitHub's Marketplace/App page rather than via
      // Critiq's own "Connect GitHub" button. Critiq doesn't know which
      // organization it belongs to, so hand off to an FE flow that asks the
      // user to pick one, rather than silently failing. A request with no
      // installation has nothing to claim.
      if (!query.installation_id) {
        res.redirect(feUrl);
        return;
      }
      res.redirect(
        `${feUrl}/integrations/github/claim?installation_id=${encodeURIComponent(query.installation_id)}`,
      );
      return;
    }
    const redirectBase = this.redirectBaseFor(feUrl, intent);
    const separator = redirectBase.includes('?') ? '&' : '?';

    // Requested from the GitHub organization's owner: nothing to connect
    // yet — record the pending request and say so. Any installation_id on
    // a request is ignored: binding one (even as pending) would let an org
    // claim an installation it never proved it can see.
    if (query.setup_action === 'request' || !query.installation_id) {
      try {
        await this.integrationsService.markGithubPendingApproval(
          intent.orgId,
          intent.userId,
        );
        res.redirect(`${redirectBase}${separator}github=pending_approval`);
      } catch {
        res.redirect(`${redirectBase}${separator}github=error`);
      }
      return;
    }

    // installation_id is only a claim (it can be spoofed): park it and let
    // the user prove through GitHub's OAuth web flow that it is theirs.
    try {
      const verificationState = await this.verificationService.begin({
        orgId: intent.orgId,
        orgSlug: intent.orgSlug,
        userId: intent.userId,
        returnTo: intent.returnTo,
        installationId: query.installation_id,
        setupAction: query.setup_action,
      });
      res.redirect(
        this.githubAppService.userAuthorizationUrl(verificationState),
      );
    } catch {
      res.redirect(`${redirectBase}${separator}github=error`);
    }
  }

  // GitHub's OAuth web flow returns here (one of the App's Callback URLs):
  // the installation is connected only when the user who authorized can
  // see it with their own token. Effective path:
  // /api/v1/github/installations/authorize/callback.
  @Get('authorize/callback')
  async authorizeCallback(
    @Query() query: GithubAuthorizeCallbackDto,
    @Res() res: Response,
  ): Promise<void> {
    const feUrl = this.configService.getOrThrow<string>('feUrl');
    const pending = query.state
      ? await this.verificationService.take(query.state)
      : null;
    if (!pending) {
      res.redirect(`${feUrl}/?github=error&reason=state_expired`);
      return;
    }
    const redirectBase = this.redirectBaseFor(feUrl, pending);
    const separator = redirectBase.includes('?') ? '&' : '?';
    const fail = (reason?: string) =>
      res.redirect(
        `${redirectBase}${separator}github=error${reason ? `&reason=${reason}` : ''}`,
      );

    // Declined on GitHub (error=access_denied) or no code at all.
    if (!query.code) {
      fail('authorization_required');
      return;
    }

    try {
      const owned = await this.githubAppService.userCanAccessInstallation(
        query.code,
        pending.installationId,
      );
      if (!owned) {
        fail('installation_not_owned');
        return;
      }
      const installation = await this.githubAppService.verifyInstallation(
        pending.installationId,
      );
      await this.integrationsService.connectGithub(
        pending.orgId,
        pending.userId,
        installation,
        pending.setupAction,
      );
      res.redirect(`${redirectBase}${separator}github=connected`);
    } catch {
      // verifyInstallation (installation_invalid / github_unreachable), a
      // failed code exchange, or connectGithub's installation_in_use — a
      // browser-navigated request, so a reason-less redirect, not JSON.
      fail();
    }
  }

  // FE routes: the onboarding wizard, or the org's Settings page
  // (`app/[slug]/settings` — by slug, and the Integrations card lives on
  // that page; it reads `?github=` and toasts). The old
  // `/orgs/:orgId/settings/integrations` does not exist there: every
  // install from Settings landed on a 404.
  private redirectBaseFor(
    feUrl: string,
    target: { orgId: string; orgSlug: string; returnTo: GithubInstallReturnTo },
  ): string {
    return target.returnTo === GithubInstallReturnTo.SETUP
      ? `${feUrl}/setup?step=2&orgId=${target.orgId}`
      : `${feUrl}/${encodeURIComponent(target.orgSlug)}/settings`;
  }
}
