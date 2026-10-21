import { UnprocessableEntityException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Profile } from 'passport-github2';
import { Provider } from '../../../generated/prisma/enums';
import { AuthService } from '../auth.service';
import { GithubStrategy } from './github.strategy';

interface StrategyOptions {
  scope: string[];
  callbackURL: string;
}

// Captures the options handed to Passport instead of running it.
jest.mock('@nestjs/passport', () => ({
  PassportStrategy: () =>
    class {
      constructor(public readonly options: StrategyOptions) {}
    },
}));
jest.mock('@nestjs/config', () => ({ ConfigService: class {} }));
jest.mock('../auth.service', () => ({ AuthService: class {} }));

function setup() {
  const config = { getOrThrow: jest.fn((key: string) => `cfg:${key}`) };
  const auth = { loginWithOAuth: jest.fn().mockResolvedValue({}) };
  const strategy = new GithubStrategy(
    config as unknown as ConfigService,
    auth as unknown as AuthService,
  );
  const { options } = strategy as unknown as { options: StrategyOptions };
  return { strategy, options, auth };
}

const profile = (overrides: Partial<Profile> = {}) =>
  ({
    id: '1001',
    username: 'dev',
    displayName: 'Dev Person',
    emails: [{ value: 'dev@example.com' }],
    photos: [{ value: 'https://example.com/a.png' }],
    ...overrides,
  }) as Profile;

describe('GithubStrategy', () => {
  // PRD v1.4/D3: login proves identity only — repo access comes from the
  // GitHub App installation.
  it('asks GitHub for the email only', () => {
    const { options } = setup();
    expect(options.scope).toEqual(['user:email']);
    expect(options.callbackURL).toBe('cfg:github.redirectUrl');
  });

  it('logs the GitHub identity in', async () => {
    const { strategy, auth } = setup();
    await strategy.validate('{{AT}}', '{{RT}}', profile());
    expect(auth.loginWithOAuth).toHaveBeenCalledWith({
      provider: Provider.GITHUB,
      providerAccountId: '1001',
      email: 'dev@example.com',
      name: 'Dev Person',
      avatarUrl: 'https://example.com/a.png',
      accessToken: '{{AT}}',
      refreshToken: '{{RT}}',
    });
  });

  it('falls back to the username without a display name or photo', async () => {
    const { strategy, auth } = setup();
    await strategy.validate(
      '{{AT}}',
      '',
      profile({ displayName: undefined as unknown as string, photos: [] }),
    );
    expect(auth.loginWithOAuth).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'dev', avatarUrl: undefined }),
    );
  });

  it('refuses a profile without an email', async () => {
    const { strategy, auth } = setup();
    await expect(
      strategy.validate('{{AT}}', '', profile({ emails: [] })),
    ).rejects.toThrow(UnprocessableEntityException);
    expect(auth.loginWithOAuth).not.toHaveBeenCalled();
  });
});
