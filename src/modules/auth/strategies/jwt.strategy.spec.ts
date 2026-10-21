import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Provider } from '../../../generated/prisma/enums';
import { JwtPayload } from '../auth.service';
import { JwtStrategy } from './jwt.strategy';

interface StrategyOptions {
  jwtFromRequest: (req: unknown) => string | null;
  secretOrKey: string;
}

// Captures the options handed to passport-jwt instead of running Passport.
jest.mock('@nestjs/passport', () => ({
  PassportStrategy: () =>
    class {
      constructor(public readonly options: StrategyOptions) {}
    },
}));
jest.mock('@nestjs/config', () => ({ ConfigService: class {} }));

function setup() {
  const config = { getOrThrow: jest.fn().mockReturnValue('jwt-secret') };
  const strategy = new JwtStrategy(config as unknown as ConfigService);
  const { options } = strategy as unknown as { options: StrategyOptions };
  return { strategy, options, config };
}

const PAYLOAD: JwtPayload = {
  sub: 'user_1',
  activeOrgId: null,
  role: null,
  provider: Provider.GITHUB,
  onboardingCompleted: false,
};

describe('JwtStrategy', () => {
  // CLAUDE.md "Arsitektur domain & auth": the session lives in an httpOnly
  // cookie, never an Authorization header.
  it('reads the token from the session cookie only', () => {
    const { options } = setup();
    expect(options.jwtFromRequest({ cookies: { session: 'a.b.c' } })).toBe(
      'a.b.c',
    );
    expect(
      options.jwtFromRequest({
        cookies: {},
        headers: { authorization: 'Bearer a.b.c' },
      }),
    ).toBeNull();
    expect(options.jwtFromRequest({})).toBeNull();
  });

  it('verifies with the configured secret', () => {
    const { options, config } = setup();
    expect(config.getOrThrow).toHaveBeenCalledWith('jwt.secret');
    expect(options.secretOrKey).toBe('jwt-secret');
  });

  it('passes a payload with a subject through unchanged', () => {
    const { strategy } = setup();
    expect(strategy.validate(PAYLOAD)).toBe(PAYLOAD);
  });

  it('rejects a payload without a subject', () => {
    const { strategy } = setup();
    expect(() => strategy.validate({ ...PAYLOAD, sub: '' })).toThrow(
      UnauthorizedException,
    );
  });
});
