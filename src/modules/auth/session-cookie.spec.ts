import type { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { SessionCookieService } from './session-cookie';

jest.mock('@nestjs/config', () => ({ ConfigService: class {} }));

function response() {
  return { cookie: jest.fn(), clearCookie: jest.fn() };
}

function service(sameSite?: string) {
  return new SessionCookieService({
    get: () => sameSite,
  } as unknown as ConfigService);
}

describe('session cookie', () => {
  it('is httpOnly, Secure and SameSite=Lax for a day by default', () => {
    const res = response();
    service().set(res as unknown as Response, 'jwt');
    expect(res.cookie).toHaveBeenCalledWith('session', 'jwt', {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      maxAge: 86_400_000,
    });
  });

  it('takes SameSite from SESSION_COOKIE_SAMESITE (local dev: none)', () => {
    const res = response();
    service('none').set(res as unknown as Response, 'jwt');
    expect(res.cookie).toHaveBeenCalledWith(
      'session',
      'jwt',
      expect.objectContaining({ sameSite: 'none', secure: true }),
    );
  });

  // A browser only drops a cookie cleared with the attributes it was set
  // with.
  it('is cleared with the same attributes', () => {
    const res = response();
    service().clear(res as unknown as Response);
    expect(res.clearCookie).toHaveBeenCalledWith('session', {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
    });
  });
});
