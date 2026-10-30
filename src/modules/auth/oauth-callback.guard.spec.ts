import type { ArgumentsHost } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import {
  OAuthCallbackGuard,
  OAuthStateMismatchException,
  OAuthStateMismatchFilter,
} from './oauth-callback.guard';

// ESM-only packages this CommonJS Jest setup cannot load. AuthGuard's own
// handleRequest throws on a missing user, like the real one.
jest.mock('@nestjs/config', () => ({ ConfigService: class {} }));
jest.mock('@nestjs/passport', () => ({
  AuthGuard: () =>
    class {
      handleRequest(err: unknown, user: unknown) {
        if (err || !user) {
          throw new Error('unauthorized');
        }
        return user;
      }
    },
}));

describe('OAuthCallbackGuard', () => {
  const guard = new (OAuthCallbackGuard('github'))() as unknown as {
    handleRequest: (err: unknown, user: unknown, info: unknown) => unknown;
  };

  it('turns a state mismatch into its own exception', () => {
    expect(() =>
      guard.handleRequest(null, false, { message: 'oauth_state' }),
    ).toThrow(OAuthStateMismatchException);
  });

  it('leaves any other refusal to AuthGuard', () => {
    expect(() =>
      guard.handleRequest(null, false, { message: 'other' }),
    ).toThrow('unauthorized');
    expect(guard.handleRequest(null, { id: 'u' }, undefined)).toEqual({
      id: 'u',
    });
  });
});

describe('OAuthStateMismatchFilter', () => {
  it('sends the browser back to the login page', () => {
    const res = { redirect: jest.fn() };
    const host = {
      switchToHttp: () => ({ getResponse: () => res }),
    } as unknown as ArgumentsHost;
    new OAuthStateMismatchFilter({
      getOrThrow: () => 'https://critiq-dev.web.id',
    } as unknown as ConfigService).catch(
      new OAuthStateMismatchException(),
      host,
    );
    expect(res.redirect).toHaveBeenCalledWith(
      'https://critiq-dev.web.id/login?error=oauth_state',
    );
  });
});
