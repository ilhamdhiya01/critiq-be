import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { GithubInstallReturnTo } from '../../generated/prisma/enums';
import { GithubAppService } from './github-app.service';
import { GithubInstallIntentService } from './github-install-intent.service';
import { GithubInstallationCallbackController } from './github-installation-callback.controller';
import { IntegrationsService } from './integrations.service';
import {
  GithubInstallVerificationService,
  PendingGithubInstallVerification,
} from './github-install-verification.service';

jest.mock('@nestjs/config', () => ({ ConfigService: class {} }));
jest.mock('./integrations.service', () => ({ IntegrationsService: class {} }));
jest.mock('./github-app.service', () => ({ GithubAppService: class {} }));
jest.mock('./github-install-intent.service', () => ({
  GithubInstallIntentService: class {},
}));
jest.mock('./github-install-verification.service', () => ({
  GithubInstallVerificationService: class {},
}));

const FE_URL = 'https://critiq-dev.web.id';

const AUTHORIZE_URL = 'https://github.com/login/oauth/authorize?state=v';

function setup(intent: Record<string, unknown> | null) {
  const intents = { consume: jest.fn().mockResolvedValue(intent) };
  const githubApp = {
    verifyInstallation: jest.fn().mockResolvedValue({ id: 169099670 }),
    userAuthorizationUrl: jest.fn().mockReturnValue(AUTHORIZE_URL),
    userCanAccessInstallation: jest.fn().mockResolvedValue(true),
  };
  // Parks what the Setup URL leg learned, returns it once on the way back.
  let parked: PendingGithubInstallVerification | null = null;
  const verification = {
    begin: jest.fn((pending: PendingGithubInstallVerification) => {
      parked = pending;
      return Promise.resolve('v');
    }),
    take: jest.fn(() => {
      const taken = parked;
      parked = null;
      return Promise.resolve(taken);
    }),
  };
  const integrations = {
    connectGithub: jest.fn().mockResolvedValue(undefined),
    markGithubPendingApproval: jest.fn().mockResolvedValue(undefined),
    findOrgSlugForGithubInstallation: jest.fn().mockResolvedValue(null),
  };
  const controller = new GithubInstallationCallbackController(
    integrations as unknown as IntegrationsService,
    githubApp as unknown as GithubAppService,
    intents as unknown as GithubInstallIntentService,
    verification as unknown as GithubInstallVerificationService,
    { getOrThrow: () => FE_URL } as unknown as ConfigService,
  );
  const res = { redirect: jest.fn() };
  return { controller, res, githubApp, integrations, verification };
}

const fromSettings = {
  orgId: 'cmuno01y1000201mlximsjjs3',
  orgSlug: 'cititex-engineer',
  userId: 'user_1',
  returnTo: GithubInstallReturnTo.SETTINGS,
};

async function callback(
  controller: GithubInstallationCallbackController,
  res: { redirect: jest.Mock },
  setupAction: 'install' | 'update' | 'request' = 'install',
): Promise<string> {
  await controller.callback(
    { installation_id: '169099670', setup_action: setupAction, state: 's' },
    res as unknown as Response,
  );
  const [url] = res.redirect.mock.calls[0] as [string];
  if (url !== AUTHORIZE_URL) {
    return url;
  }
  // Sent to GitHub's OAuth page: come back with a code, as GitHub would.
  await controller.authorizeCallback(
    { code: 'c', state: 'v' },
    res as unknown as Response,
  );
  const [finalUrl] = res.redirect.mock.calls[1] as [string];
  return finalUrl;
}

describe('GithubInstallationCallbackController', () => {
  // The FE's Settings page is `app/[slug]/settings`; the old
  // `/orgs/:orgId/settings/integrations` was a 404.
  it.each([
    ['install', 'github=connected'],
    ['request', 'github=pending_approval'],
  ] as const)(
    'sends a Settings install back to the org Settings page (%s)',
    async (action, status) => {
      const { controller, res } = setup(fromSettings);
      expect(await callback(controller, res, action)).toBe(
        `${FE_URL}/cititex-engineer/settings?${status}`,
      );
    },
  );

  it('reports a failed install on the same page', async () => {
    const { controller, res, githubApp } = setup(fromSettings);
    githubApp.verifyInstallation.mockRejectedValue(new Error('gone'));
    expect(await callback(controller, res)).toBe(
      `${FE_URL}/cititex-engineer/settings?github=error`,
    );
  });

  it('escapes the slug in the path', async () => {
    const { controller, res } = setup({ ...fromSettings, orgSlug: 'a b/c' });
    expect(await callback(controller, res)).toBe(
      `${FE_URL}/a%20b%2Fc/settings?github=connected`,
    );
  });

  it('keeps the onboarding wizard return as it was', async () => {
    const { controller, res } = setup({
      ...fromSettings,
      returnTo: GithubInstallReturnTo.SETUP,
    });
    expect(await callback(controller, res)).toBe(
      `${FE_URL}/setup?step=2&orgId=cmuno01y1000201mlximsjjs3&github=connected`,
    );
  });

  it('hands an install with no valid intent to the claim page', async () => {
    const { controller, res, integrations } = setup(null);
    expect(await callback(controller, res)).toBe(
      `${FE_URL}/integrations/github/claim?installation_id=169099670`,
    );
    expect(integrations.connectGithub).not.toHaveBeenCalled();
  });

  // "Manage on GitHub" → repository access changed on GitHub: GitHub
  // returns with setup_action=update and no Critiq state.
  describe('a change made on GitHub to a known installation', () => {
    it('goes back to that org Settings page, writing nothing', async () => {
      const { controller, res, integrations } = setup(null);
      integrations.findOrgSlugForGithubInstallation.mockResolvedValue(
        'run-system',
      );

      expect(await callback(controller, res, 'update')).toBe(
        `${FE_URL}/run-system/settings?github=updated`,
      );
      expect(
        integrations.findOrgSlugForGithubInstallation,
      ).toHaveBeenCalledWith('169099670');
      expect(integrations.connectGithub).not.toHaveBeenCalled();
    });

    it('still hands an unknown installation to the claim page', async () => {
      const { controller, res } = setup(null);
      expect(await callback(controller, res, 'update')).toBe(
        `${FE_URL}/integrations/github/claim?installation_id=169099670`,
      );
    });

    // Only an update is a change to an existing installation; a fresh
    // install without a Critiq intent is a claim.
    it('does not look up a fresh install without an intent', async () => {
      const { controller, res, integrations } = setup(null);
      integrations.findOrgSlugForGithubInstallation.mockResolvedValue(
        'run-system',
      );
      expect(await callback(controller, res, 'install')).toMatch(/\/claim\?/);
      expect(
        integrations.findOrgSlugForGithubInstallation,
      ).not.toHaveBeenCalled();
    });
  });
});

// A non-owner requested the install from the GitHub organization's owner:
// GitHub sends setup_action=request and no installation_id.
describe('GithubInstallationCallbackController — install request', () => {
  const request = { setup_action: 'request' as const, state: 's' };

  it('records the pending request and goes back to Settings', async () => {
    const { controller, res, githubApp, integrations } = setup(fromSettings);
    await controller.callback(request, res as unknown as Response);
    expect(integrations.markGithubPendingApproval).toHaveBeenCalledWith(
      fromSettings.orgId,
      fromSettings.userId,
    );
    expect(githubApp.verifyInstallation).not.toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith(
      `${FE_URL}/cititex-engineer/settings?github=pending_approval`,
    );
  });

  it('goes back to the onboarding wizard it came from', async () => {
    const { controller, res } = setup({
      ...fromSettings,
      returnTo: GithubInstallReturnTo.SETUP,
    });
    await controller.callback(request, res as unknown as Response);
    expect(res.redirect).toHaveBeenCalledWith(
      `${FE_URL}/setup?step=2&orgId=${fromSettings.orgId}&github=pending_approval`,
    );
  });

  it('has nothing to claim without an intent', async () => {
    const { controller, res } = setup(null);
    await controller.callback(request, res as unknown as Response);
    expect(res.redirect).toHaveBeenCalledWith(FE_URL);
  });
});

// The Setup URL's installation_id can be spoofed: an Admin of any org could
// pair their own intent with someone else's installation. It is connected
// only once the user proves, with their own GitHub token, they can see it.
describe('GithubInstallationCallbackController — ownership check', () => {
  const install = {
    installation_id: '169099670',
    setup_action: 'install' as const,
    state: 's',
  };

  it('sends the user to GitHub before connecting anything', async () => {
    const { controller, res, integrations, verification } = setup(fromSettings);
    await controller.callback(install, res as unknown as Response);
    expect(res.redirect).toHaveBeenCalledWith(AUTHORIZE_URL);
    expect(verification.begin).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: fromSettings.orgId,
        installationId: '169099670',
        setupAction: 'install',
      }),
    );
    expect(integrations.connectGithub).not.toHaveBeenCalled();
  });

  it('refuses an installation the user cannot see', async () => {
    const { controller, res, githubApp, integrations } = setup(fromSettings);
    githubApp.userCanAccessInstallation.mockResolvedValue(false);
    await controller.callback(install, res as unknown as Response);
    await controller.authorizeCallback(
      { code: 'c', state: 'v' },
      res as unknown as Response,
    );
    expect(res.redirect).toHaveBeenLastCalledWith(
      `${FE_URL}/cititex-engineer/settings?github=error&reason=installation_not_owned`,
    );
    expect(integrations.connectGithub).not.toHaveBeenCalled();
  });

  it('needs the authorization (declined on GitHub)', async () => {
    const { controller, res, integrations } = setup(fromSettings);
    await controller.callback(install, res as unknown as Response);
    await controller.authorizeCallback(
      { state: 'v', error: 'access_denied' },
      res as unknown as Response,
    );
    expect(res.redirect).toHaveBeenLastCalledWith(
      `${FE_URL}/cititex-engineer/settings?github=error&reason=authorization_required`,
    );
    expect(integrations.connectGithub).not.toHaveBeenCalled();
  });

  it('refuses an unknown or reused state', async () => {
    const { controller, res, integrations } = setup(fromSettings);
    await controller.authorizeCallback(
      { code: 'c', state: 'forged' },
      res as unknown as Response,
    );
    expect(res.redirect).toHaveBeenCalledWith(
      `${FE_URL}/?github=error&reason=state_expired`,
    );
    expect(integrations.connectGithub).not.toHaveBeenCalled();
  });

  it('connects once the user can see the installation', async () => {
    const { controller, res, githubApp, integrations } = setup(fromSettings);
    expect(await callback(controller, res)).toBe(
      `${FE_URL}/cititex-engineer/settings?github=connected`,
    );
    expect(githubApp.userCanAccessInstallation).toHaveBeenCalledWith(
      'c',
      '169099670',
    );
    expect(integrations.connectGithub).toHaveBeenCalledWith(
      fromSettings.orgId,
      fromSettings.userId,
      { id: 169099670 },
      'install',
    );
  });

  // A request never binds an installation_id, verified or not.
  it('records a request with an installation_id as pending only', async () => {
    const { controller, res, integrations, verification } = setup(fromSettings);
    await controller.callback(
      { ...install, setup_action: 'request' },
      res as unknown as Response,
    );
    expect(verification.begin).not.toHaveBeenCalled();
    expect(integrations.connectGithub).not.toHaveBeenCalled();
    expect(integrations.markGithubPendingApproval).toHaveBeenCalled();
  });
});
