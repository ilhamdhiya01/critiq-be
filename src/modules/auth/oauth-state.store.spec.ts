import type { Request } from 'express';
import type { Metadata } from 'passport-oauth2';
import { OAUTH_STATE_COOKIE, OAuthCookieStateStore } from './oauth-state.store';

const META = {} as Metadata;

function request(cookies: Record<string, string> = {}) {
  const res = { cookie: jest.fn(), clearCookie: jest.fn() };
  return { req: { cookies, res } as unknown as Request, res };
}

describe('OAuthCookieStateStore', () => {
  // passport-oauth2 picks the call shape from Function.length.
  it('has the arities passport calls with metadata', () => {
    const store = new OAuthCookieStateStore();
    expect(store.store.length).toBe(3);
    expect(store.verify.length).toBe(4);
  });

  it('binds a random state to the browser in an httpOnly cookie', () => {
    const { req, res } = request();
    const callback = jest.fn();
    new OAuthCookieStateStore().store(req, META, callback);
    const [, state] = callback.mock.calls[0] as [null, string];
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(res.cookie).toHaveBeenCalledWith(
      OAUTH_STATE_COOKIE,
      state,
      expect.objectContaining({
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        path: '/api/v1/auth',
      }),
    );
  });

  it('accepts the state that browser brings back, once', () => {
    const { req, res } = request({ [OAUTH_STATE_COOKIE]: 'abc' });
    const callback = jest.fn();
    new OAuthCookieStateStore().verify(req, 'abc', META, callback);
    expect(callback).toHaveBeenCalledWith(null, true, undefined);
    expect(res.clearCookie).toHaveBeenCalled();
  });

  // Login CSRF: a callback started in another browser (the attacker's).
  it.each([
    [{ [OAUTH_STATE_COOKIE]: 'abc' }, 'abd'],
    [{}, 'abc'],
    [{ [OAUTH_STATE_COOKIE]: 'abc' }, undefined],
  ])('refuses cookie %p with state %p', (cookies, state) => {
    const { req } = request(cookies);
    const callback = jest.fn();
    new OAuthCookieStateStore().verify(
      req,
      state as unknown as string,
      META,
      callback,
    );
    expect(callback).toHaveBeenCalledWith(null, false, {
      message: 'oauth_state',
    });
  });
});
