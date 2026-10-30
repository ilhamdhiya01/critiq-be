import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { CookieOptions, Response } from 'express';

export type SessionCookieSameSite = 'lax' | 'strict' | 'none';

const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// Attributes shared by setting and clearing: a browser only drops a cookie
// cleared with the attributes it was set with. SameSite comes from
// SESSION_COOKIE_SAMESITE — `lax` wherever FE and BE are same-origin (staging,
// prod), `none` only for local dev across schemes. `none` once was hardcoded
// everywhere, which let any site's form POST ride the session (CLAUDE.md
// "Keamanan").
export function sessionCookieOptions(
  sameSite: SessionCookieSameSite,
): CookieOptions {
  return { httpOnly: true, secure: true, sameSite };
}

// The session cookie, the same wherever a session is issued, reissued
// (login, new organization, accepted invitation, onboarding) or cleared
// (logout).
@Injectable()
export class SessionCookieService {
  private readonly options: CookieOptions;

  constructor(configService: ConfigService) {
    this.options = sessionCookieOptions(
      configService.get<SessionCookieSameSite>('session.cookieSameSite') ??
        'lax',
    );
  }

  set(res: Response, token: string): void {
    res.cookie('session', token, {
      ...this.options,
      maxAge: SESSION_MAX_AGE_MS,
    });
  }

  clear(res: Response): void {
    res.clearCookie('session', this.options);
  }
}
