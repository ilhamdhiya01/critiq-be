import { HttpService } from '@nestjs/axios';
import { UnprocessableEntityException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { of, throwError } from 'rxjs';
import { Provider } from '../../../generated/prisma/enums';
import { AuthService } from '../auth.service';
import { GitlabStrategy } from './gitlab.strategy';

interface StrategyOptions {
  scope: string[];
  authorizationURL: string;
  tokenURL: string;
}

// Captures the options handed to Passport instead of running it.
jest.mock('@nestjs/passport', () => ({
  PassportStrategy: () =>
    class {
      constructor(public readonly options: StrategyOptions) {}
    },
}));
jest.mock('@nestjs/config', () => ({ ConfigService: class {} }));
jest.mock('@nestjs/axios', () => ({ HttpService: class {} }));
jest.mock('../auth.service', () => ({ AuthService: class {} }));

function setup() {
  const config = { getOrThrow: jest.fn((key: string) => `cfg:${key}`) };
  const auth = { loginWithOAuth: jest.fn().mockResolvedValue({}) };
  const http = { get: jest.fn() };
  const strategy = new GitlabStrategy(
    config as unknown as ConfigService,
    auth as unknown as AuthService,
    http as unknown as HttpService,
  );
  const { options } = strategy as unknown as { options: StrategyOptions };
  return { strategy, options, auth, http };
}

const PROFILE = {
  id: 42,
  username: 'dev',
  name: 'Dev Person',
  email: 'dev@example.com',
  avatar_url: 'https://example.com/a.png',
};

// Resolves with what userProfile hands to Passport's callback.
const loadProfile = (strategy: GitlabStrategy) =>
  new Promise<{ error: unknown; profile: unknown }>((resolve) =>
    strategy.userProfile('{{AT}}', (error, profile) =>
      resolve({ error, profile }),
    ),
  );

describe('GitlabStrategy', () => {
  // PRD v1.4/D3: one fixed gitlab.com app, identity only — repo access
  // comes from the org's access token.
  it('asks gitlab.com for read_user only', () => {
    const { options } = setup();
    expect(options.scope).toEqual(['read_user']);
    expect(options.authorizationURL).toBe('https://gitlab.com/oauth/authorize');
    expect(options.tokenURL).toBe('https://gitlab.com/oauth/token');
  });

  it('reads the profile from gitlab.com with the login token', async () => {
    const { strategy, http } = setup();
    http.get.mockReturnValue(of({ data: PROFILE }));
    await expect(loadProfile(strategy)).resolves.toEqual({
      error: undefined,
      profile: PROFILE,
    });
    expect(http.get).toHaveBeenCalledWith('https://gitlab.com/api/v4/user', {
      headers: { Authorization: 'Bearer {{AT}}' },
    });
  });

  it('hands a failed profile request back to Passport', async () => {
    const { strategy, http } = setup();
    const failure = new Error('401');
    http.get.mockReturnValue(throwError(() => failure));
    await expect(loadProfile(strategy)).resolves.toEqual({
      error: failure,
      profile: undefined,
    });
  });

  it('logs the GitLab identity in, without a refresh token', async () => {
    const { strategy, auth } = setup();
    await strategy.validate('{{AT}}', '{{RT}}', PROFILE);
    expect(auth.loginWithOAuth).toHaveBeenCalledWith({
      provider: Provider.GITLAB,
      providerAccountId: '42',
      email: 'dev@example.com',
      name: 'Dev Person',
      avatarUrl: 'https://example.com/a.png',
      accessToken: '{{AT}}',
    });
  });

  it('refuses a profile without an email', async () => {
    const { strategy, auth } = setup();
    await expect(
      strategy.validate('{{AT}}', '', { ...PROFILE, email: '' }),
    ).rejects.toThrow(UnprocessableEntityException);
    expect(auth.loginWithOAuth).not.toHaveBeenCalled();
  });
});
