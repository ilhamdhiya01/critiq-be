import { randomBytes, timingSafeEqual } from 'crypto';
import type { Request } from 'express';
import type {
  Metadata,
  StateStore,
  StateStoreStoreCallback,
  StateStoreVerifyCallback,
} from 'passport-oauth2';

export const OAUTH_STATE_COOKIE = 'oauth_state';
// Message passport-oauth2 hands back when verify refuses — matched by
// OAuthCallbackGuard to send the browser back to the login page.
export const OAUTH_STATE_FAILURE = 'oauth_state';

const STATE_BYTES = 32;
const STATE_TTL_MS = 10 * 60 * 1000;

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  // The provider's redirect back is a top-level GET navigation: Lax sends it.
  sameSite: 'lax',
  path: '/api/v1/auth',
} as const;

function sameValue(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

// passport-oauth2 state store without express-session (CLAUDE.md
// "Keamanan" — login CSRF). The state lives in a short-lived httpOnly cookie
// bound to the browser that started the login; the callback must bring the
// same value back. Without it, an attacker could finish their own OAuth
// login in a victim's browser and have the victim work inside the
// attacker's account. Arity matters: passport picks the call shape from the
// function length — 3 for store (req, meta, cb), 4 for verify (req, state,
// meta, cb); the two-argument overloads of the type are accepted too.
export class OAuthCookieStateStore implements StateStore {
  store(
    req: Request,
    metaOrCallback: Metadata | StateStoreStoreCallback,
    maybeCallback?: StateStoreStoreCallback,
  ): void {
    const callback =
      maybeCallback ?? (metaOrCallback as StateStoreStoreCallback);
    const state = randomBytes(STATE_BYTES).toString('base64url');
    req.res?.cookie(OAUTH_STATE_COOKIE, state, {
      ...COOKIE_OPTIONS,
      maxAge: STATE_TTL_MS,
    });
    callback(null, state);
  }

  verify(
    req: Request,
    state: string,
    metaOrCallback: Metadata | StateStoreVerifyCallback,
    maybeCallback?: StateStoreVerifyCallback,
  ): void {
    const callback =
      maybeCallback ?? (metaOrCallback as StateStoreVerifyCallback);
    const expected: unknown = (req.cookies as Record<string, unknown>)?.[
      OAUTH_STATE_COOKIE
    ];
    // Single use, whatever the outcome.
    req.res?.clearCookie(OAUTH_STATE_COOKIE, COOKIE_OPTIONS);
    if (
      typeof expected !== 'string' ||
      typeof state !== 'string' ||
      !sameValue(expected, state)
    ) {
      callback(null, false, { message: OAUTH_STATE_FAILURE });
      return;
    }
    callback(null, true, undefined);
  }
}
