import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../../common/prisma/prisma.service';
import { Provider, Role, User } from '../../generated/prisma/client';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import { Logger } from 'winston';

export interface JwtPayload {
  sub: string;
  activeOrgId: string | null;
  role: Role | null;
  provider: Provider;
}

export interface OAuthProfile {
  provider: Provider;
  providerAccountId: string;
  email: string;
  name?: string;
  avatarUrl?: string;
  accessToken: string;
  refreshToken?: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    @Inject(WINSTON_MODULE_PROVIDER) private logger: Logger,
  ) {}

  issueSessionToken(
    userId: string,
    activeOrgId: string | null,
    role: Role | null,
    provider: Provider,
  ): string {
    const payload: JwtPayload = { sub: userId, activeOrgId, role, provider };
    return this.jwtService.sign(payload);
  }

  async loginWithOAuth(profile: OAuthProfile): Promise<{
    user: User;
    activeOrgId: string | null;
    role: Role | null;
    provider: Provider;
  }> {
    const user = await this.findOrCreateUser(profile);
    const membership = await this.prisma.membership.findFirst({
      where: { userId: user.id, status: 'ACTIVE' },
      orderBy: { lastAccessedAt: 'desc' },
    });
    return {
      user,
      activeOrgId: membership?.organizationId ?? null,
      role: membership?.role ?? null,
      provider: profile.provider,
    };
  }

  private async findOrCreateUser(profile: OAuthProfile): Promise<User> {
    const existingAccount = await this.prisma.account.findUnique({
      where: {
        provider_providerAccountId: {
          provider: profile.provider,
          providerAccountId: profile.providerAccountId,
        },
      },
      include: { user: true },
    });

    // Neither provider's login token is ever persisted here (PRD v1.4/D3):
    // GitLab login only proves identity (scope `read_user`), and GitHub
    // login is likewise identity-only (scope `user:email`) since the
    // GitHub App migration — repo access for both providers is a
    // completely separate, org-level credential handled by the
    // integrations module (GitLab: pasted access token; GitHub: App
    // installation). A live encrypted OAuth token sitting in `Account`
    // that's never actually used for anything is exactly the kind of
    // needless blast-radius surface this principle exists to avoid, so
    // `Account.accessToken`/`refreshToken` are always left unset here.

    if (existingAccount) {
      this.logger.info(
        `found existing user from OAuth profile: provider=${profile.provider} providerAccountId=${profile.providerAccountId}`,
      );
      return existingAccount.user;
    }

    const existingUser = await this.prisma.user.findUnique({
      where: { email: profile.email },
    });

    if (existingUser) {
      this.logger.info(
        `linking new provider to existing user: provider=${profile.provider} providerAccountId=${profile.providerAccountId}`,
      );
      await this.prisma.account.create({
        data: {
          provider: profile.provider,
          providerAccountId: profile.providerAccountId,
          userId: existingUser.id,
        },
      });
      return existingUser;
    }

    this.logger.info(
      `creating user from OAuth profile: provider=${profile.provider} providerAccountId=${profile.providerAccountId}`,
    );
    return this.prisma.user.create({
      data: {
        email: profile.email,
        name: profile.name,
        avatarUrl: profile.avatarUrl,
        accounts: {
          create: {
            provider: profile.provider,
            providerAccountId: profile.providerAccountId,
          },
        },
      },
    });
  }
}
