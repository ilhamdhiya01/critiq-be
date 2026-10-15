import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { GithubInstallReturnTo } from '../../generated/prisma/enums';
import { GithubAppService } from './github-app.service';
import { GithubInstallIntentService } from './github-install-intent.service';
import { GithubInstallationCallbackController } from './github-installation-callback.controller';
import { IntegrationsService } from './integrations.service';

jest.mock('@nestjs/config', () => ({ ConfigService: class {} }));
jest.mock('./integrations.service', () => ({ IntegrationsService: class {} }));
jest.mock('./github-app.service', () => ({ GithubAppService: class {} }));
jest.mock('./github-install-intent.service', () => ({
  GithubInstallIntentService: class {},
}));

const FE_URL = 'https://critiq-dev.web.id';

function setup(intent: Record<string, unknown> | null) {
  const intents = { consume: jest.fn().mockResolvedValue(intent) };
  const githubApp = {
    verifyInstallation: jest.fn().mockResolvedValue({ id: 169099670 }),
  };
  const integrations = {
    connectGithub: jest.fn().mockResolvedValue(undefined),
    findOrgSlugForGithubInstallation: jest.fn().mockResolvedValue(null),
  };
  const controller = new GithubInstallationCallbackController(
    integrations as unknown as IntegrationsService,
    githubApp as unknown as GithubAppService,
    intents as unknown as GithubInstallIntentService,
    { getOrThrow: () => FE_URL } as unknown as ConfigService,
  );
  const res = { redirect: jest.fn() };
  return { controller, res, githubApp, integrations };
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
  return url;
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
