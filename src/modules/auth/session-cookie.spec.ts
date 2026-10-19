import type { Response } from 'express';
import { clearSessionCookie, setSessionCookie } from './session-cookie';

function response() {
  return { cookie: jest.fn(), clearCookie: jest.fn() };
}

describe('session cookie', () => {
  it('is httpOnly, Secure and SameSite=None for a day', () => {
    const res = response();
    setSessionCookie(res as unknown as Response, 'jwt');
    expect(res.cookie).toHaveBeenCalledWith('session', 'jwt', {
      httpOnly: true,
      secure: true,
      sameSite: 'none',
      maxAge: 86_400_000,
    });
  });

  // A browser only drops a cookie cleared with the attributes it was set
  // with.
  it('is cleared with the same attributes', () => {
    const res = response();
    clearSessionCookie(res as unknown as Response);
    expect(res.clearCookie).toHaveBeenCalledWith('session', {
      httpOnly: true,
      secure: true,
      sameSite: 'none',
    });
  });
});
