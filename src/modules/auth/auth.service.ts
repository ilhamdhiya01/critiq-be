import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../../common/prisma/prisma.service';
import { EncryptionService } from '../../common/encryption/encryption.service';
import { Provider, User } from '../../generated/prisma/client';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import { Logger } from 'winston';

export interface JwtPayload {
  sub: string;
  role: User['role'];
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
    private readonly encryptionService: EncryptionService,
    @Inject(WINSTON_MODULE_PROVIDER) private logger: Logger,
  ) {}

  issueSessionToken(user: User): string {
    const payload: JwtPayload = { sub: user.id, role: user.role };
    return this.jwtService.sign(payload);
  }

  async findOrCreateFromOAuth(profile: OAuthProfile): Promise<User> {
    const existingAccount = await this.prisma.account.findUnique({
      where: {
        provider_providerAccountId: {
          provider: profile.provider,
          providerAccountId: profile.providerAccountId,
        },
      },
      include: { user: true },
    });

    const encryptedAccessToken = this.encryptionService.encrypt(
      profile.accessToken,
    );
    const encryptedRefreshToken = profile.refreshToken
      ? this.encryptionService.encrypt(profile.refreshToken)
      : undefined;

    if (existingAccount) {
      this.logger.info(
        `found existing user from OAuth profile: provider=${profile.provider} providerAccountId=${profile.providerAccountId}`,
      );
      await this.prisma.account.update({
        where: { id: existingAccount.id },
        data: {
          accessToken: encryptedAccessToken,
          refreshToken: encryptedRefreshToken,
        },
      });
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
          accessToken: encryptedAccessToken,
          refreshToken: encryptedRefreshToken,
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
            accessToken: encryptedAccessToken,
            refreshToken: encryptedRefreshToken,
          },
        },
      },
    });
  }
}
