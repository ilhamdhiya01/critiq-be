import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Logger } from 'winston';
import { PrismaService } from '../../common/prisma/prisma.service';
import { Provider, Role } from '../../generated/prisma/enums';
import { AuthService, JwtPayload, OAuthProfile } from './auth.service';

jest.mock('@nestjs/jwt', () => ({ JwtService: class {} }));
jest.mock('../../common/prisma/prisma.service', () => ({
  PrismaService: class {},
}));

const USER = { id: 'user_1', email: 'dev@example.com', name: 'Dev' };

const PROFILE: OAuthProfile = {
  provider: Provider.GITLAB,
  providerAccountId: '42',
  email: 'dev@example.com',
  name: 'Dev',
  avatarUrl: 'https://example.com/a.png',
  accessToken: '{{OAUTH_ACCESS_TOKEN}}',
  refreshToken: '{{OAUTH_REFRESH_TOKEN}}',
};

const PAYLOAD: JwtPayload = {
  sub: USER.id,
  activeOrgId: 'org_1',
  role: Role.REVIEWER,
  provider: Provider.GITHUB,
  onboardingCompleted: true,
};

function setup({
  account = null as { user: typeof USER } | null,
  userByEmail = null as typeof USER | null,
  membership = null as {
    organizationId: string;
    role: Role;
    organization: { onboardingCompleted: boolean };
  } | null,
} = {}) {
  const prisma = {
    account: {
      findUnique: jest.fn().mockResolvedValue(account),
      create: jest.fn().mockResolvedValue({}),
    },
    user: {
      findUnique: jest.fn().mockResolvedValue(userByEmail),
      create: jest.fn().mockResolvedValue(USER),
    },
    membership: { findFirst: jest.fn().mockResolvedValue(membership) },
  };
  const jwt = { sign: jest.fn().mockReturnValue('signed.jwt') };
  const logger = { info: jest.fn() };
  const service = new AuthService(
    prisma as unknown as PrismaService,
    jwt as unknown as JwtService,
    logger as unknown as Logger,
  );
  return { service, prisma, jwt };
}

describe('AuthService', () => {
  describe('issueSessionToken', () => {
    it('signs the payload as given', () => {
      const { service, jwt } = setup();
      expect(service.issueSessionToken(PAYLOAD)).toBe('signed.jwt');
      expect(jwt.sign).toHaveBeenCalledWith(PAYLOAD);
    });
  });

  describe('getSessionUser', () => {
    // Profile from the DB, session scope from the token.
    it('combines a fresh profile with the token’s org context', async () => {
      const { service, prisma } = setup();
      prisma.user.findUnique.mockResolvedValue({ ...USER, avatarUrl: null });
      await expect(service.getSessionUser(PAYLOAD)).resolves.toMatchObject({
        id: USER.id,
        email: USER.email,
        activeOrgId: 'org_1',
        role: Role.REVIEWER,
        provider: Provider.GITHUB,
        onboardingCompleted: true,
      });
      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { id: USER.id },
      });
    });

    it('treats a token for a deleted user as invalid', async () => {
      const { service } = setup();
      await expect(service.getSessionUser(PAYLOAD)).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('loginWithOAuth', () => {
    it('signs a known account in as its user', async () => {
      const { service, prisma } = setup({ account: { user: USER } });
      const result = await service.loginWithOAuth(PROFILE);
      expect(result.user).toBe(USER);
      expect(prisma.account.findUnique).toHaveBeenCalledWith({
        where: {
          provider_providerAccountId: {
            provider: Provider.GITLAB,
            providerAccountId: '42',
          },
        },
        include: { user: true },
      });
      expect(prisma.user.create).not.toHaveBeenCalled();
      expect(prisma.account.create).not.toHaveBeenCalled();
    });

    it('links a second provider to the user with the same email', async () => {
      const { service, prisma } = setup({ userByEmail: USER });
      const result = await service.loginWithOAuth(PROFILE);
      expect(result.user).toBe(USER);
      expect(prisma.account.create).toHaveBeenCalledWith({
        data: {
          provider: Provider.GITLAB,
          providerAccountId: '42',
          userId: USER.id,
        },
      });
      expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it('creates the user and its account on first login', async () => {
      const { service, prisma } = setup();
      await service.loginWithOAuth(PROFILE);
      expect(prisma.user.create).toHaveBeenCalledWith({
        data: {
          email: PROFILE.email,
          name: PROFILE.name,
          avatarUrl: PROFILE.avatarUrl,
          accounts: {
            create: { provider: Provider.GITLAB, providerAccountId: '42' },
          },
        },
      });
    });

    // PRD v1.4/D3: login proves identity only; its token is never stored.
    it.each([
      ['linking a provider', { userByEmail: USER }],
      ['creating a user', {}],
    ])('never stores the login token when %s', async (_, state) => {
      const { service, prisma } = setup(state);
      await service.loginWithOAuth(PROFILE);
      const written = JSON.stringify([
        prisma.account.create.mock.calls,
        prisma.user.create.mock.calls,
      ]);
      expect(written).not.toContain('OAUTH_ACCESS_TOKEN');
      expect(written).not.toContain('OAUTH_REFRESH_TOKEN');
    });

    it('opens the most recently used active org', async () => {
      const { service, prisma } = setup({
        account: { user: USER },
        membership: {
          organizationId: 'org_1',
          role: Role.ADMIN,
          organization: { onboardingCompleted: true },
        },
      });
      await expect(service.loginWithOAuth(PROFILE)).resolves.toMatchObject({
        activeOrgId: 'org_1',
        role: Role.ADMIN,
        provider: Provider.GITLAB,
        onboardingCompleted: true,
      });
      expect(prisma.membership.findFirst).toHaveBeenCalledWith({
        where: { userId: USER.id, status: 'ACTIVE' },
        orderBy: { lastAccessedAt: 'desc' },
        include: { organization: true },
      });
    });

    // CLAUDE.md "Multi-tenancy": a session without an org is valid.
    it('signs in a user without any org, headed for onboarding', async () => {
      const { service } = setup({ account: { user: USER } });
      await expect(service.loginWithOAuth(PROFILE)).resolves.toMatchObject({
        activeOrgId: null,
        role: null,
        onboardingCompleted: false,
      });
    });
  });
});
