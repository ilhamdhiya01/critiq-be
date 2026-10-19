import type { Response } from 'express';

// The session cookie, the same wherever a session is issued, reissued
// (login, new organization, accepted invitation) or cleared (logout).
// SameSite=None + Secure: see main.ts for why (cross-origin local dev over
// HTTPS).
const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: 'none',
} as const;

export function setSessionCookie(res: Response, token: string): void {
  res.cookie('session', token, {
    ...SESSION_COOKIE_OPTIONS,
    maxAge: 24 * 60 * 60 * 1000,
  });
}

// Same attributes as when it was set, or the browser keeps it.
export function clearSessionCookie(res: Response): void {
  res.clearCookie('session', SESSION_COOKIE_OPTIONS);
}
