import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { Provider, Role } from '../../generated/prisma/enums';
import { AuthController } from './auth.controller';
import { AuthService, JwtPayload } from './auth.service';
import { SessionCookieService } from './session-cookie';

// @nestjs/passport and @nestjs/config ship ESM-only builds this CommonJS
// Jest setup cannot load; the guards are not what these tests are about.
jest.mock('@nestjs/passport', () => ({ AuthGuard: () => class {} }));
jest.mock('@nestjs/config', () => ({ ConfigService: class {} }));
jest.mock('./auth.service', () => ({ AuthService: class {} }));

const FE_URL = 'https://critiq-dev.web.id';

function setup() {
  const auth = {
    issueSessionToken: jest.fn().mockReturnValue('signed.jwt'),
    getSessionUser: jest.fn().mockResolvedValue({ id: 'user_1' }),
  };
  const config = { getOrThrow: jest.fn().mockReturnValue(FE_URL) };
  const controller = new AuthController(
    auth as unknown as AuthService,
    config as unknown as ConfigService,
    new SessionCookieService({
      get: () => undefined,
    } as unknown as ConfigService),
  );
  const res = {
    cookie: jest.fn(),
    clearCookie: jest.fn(),
    redirect: jest.fn(),
  };
  return { controller, auth, res, response: res as unknown as Response };
}

// What a Passport OAuth strategy leaves on the request (loginWithOAuth).
const loggedIn = (provider: Provider) =>
  ({
    user: {
      user: { id: 'user_1' },
      activeOrgId: 'org_1',
      role: Role.ADMIN,
      provider,
      onboardingCompleted: true,
    },
  }) as unknown as Parameters<AuthController['githubCallback']>[0];

describe('AuthController', () => {
  describe.each([
    ['githubCallback', Provider.GITHUB],
    ['gitlabCallback', Provider.GITLAB],
  ] as const)('%s', (handler, provider) => {
    it('issues a session for the active org of the login', () => {
      const { controller, auth, response } = setup();
      controller[handler](loggedIn(provider), response);
      expect(auth.issueSessionToken).toHaveBeenCalledWith({
        sub: 'user_1',
        activeOrgId: 'org_1',
        role: Role.ADMIN,
        provider,
        onboardingCompleted: true,
      });
    });

    // The browser never sees the token from JS: httpOnly cookie, then a
    // plain redirect back to the FE.
    it('sets it as an httpOnly cookie and redirects to the FE', () => {
      const { controller, res, response } = setup();
      controller[handler](loggedIn(provider), response);
      expect(res.cookie).toHaveBeenCalledWith(
        'session',
        'signed.jwt',
        expect.objectContaining({ httpOnly: true, secure: true }),
      );
      expect(res.redirect).toHaveBeenCalledWith(FE_URL);
    });
  });

  describe('me', () => {
    it('returns the session user for the token payload', async () => {
      const { controller, auth } = setup();
      const payload = { sub: 'user_1' } as JwtPayload;
      await expect(
        controller.me({ user: payload } as Request & { user: JwtPayload }),
      ).resolves.toEqual({ id: 'user_1' });
      expect(auth.getSessionUser).toHaveBeenCalledWith(payload);
    });
  });

  describe('logout', () => {
    it('clears the session cookie', () => {
      const { controller, res, response } = setup();
      expect(controller.logout(response)).toEqual({ loggedOut: true });
      expect(res.clearCookie).toHaveBeenCalledWith(
        'session',
        expect.objectContaining({ httpOnly: true, secure: true }),
      );
    });
  });
});
