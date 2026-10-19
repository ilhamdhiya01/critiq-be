import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

// @nestjs/passport and @nestjs/config ship ESM-only builds this CommonJS
// Jest setup cannot load; the guards are not what these tests are about.
jest.mock('@nestjs/passport', () => ({ AuthGuard: () => class {} }));
jest.mock('@nestjs/config', () => ({ ConfigService: class {} }));
jest.mock('./auth.service', () => ({ AuthService: class {} }));

describe('AuthController.logout', () => {
  it('clears the session cookie', () => {
    const controller = new AuthController(
      {} as AuthService,
      {} as ConfigService,
    );
    const res = { clearCookie: jest.fn() };
    expect(controller.logout(res as unknown as Response)).toEqual({
      loggedOut: true,
    });
    expect(res.clearCookie).toHaveBeenCalledWith(
      'session',
      expect.objectContaining({ httpOnly: true, secure: true }),
    );
  });
});
