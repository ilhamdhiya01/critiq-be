import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../../common/prisma/prisma.service';
import { EncryptionService } from '../../common/encryption/encryption.service';
import { SlugService } from '../../common/slug/slug.service';
import { Provider, Role, User } from '../../generated/prisma/client';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import { Logger } from 'winston';

export interface JwtPayload {
  sub: string;
  activeOrgId: string;
  role: Role;
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
    private readonly slugService: SlugService,
    @Inject(WINSTON_MODULE_PROVIDER) private logger: Logger,
  ) {}

  issueSessionToken(user: User, activeOrgId: string, role: Role): string {
    const payload: JwtPayload = { sub: user.id, activeOrgId, role };
    return this.jwtService.sign(payload);
  }

  async loginWithOAuth(profile: OAuthProfile): Promise<{
    user: User;
    activeOrgId: string;
    role: Role;
  }> {
    const user = await this.findOrCreateUser(profile);
    const membership = await this.ensureMembership(user);
    return {
      user,
      activeOrgId: membership.organizationId,
      role: membership.role,
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

  /**
   * D2 (self-serve): kalau user tidak punya membership aktif sama sekali,
   * buat Organization baru + Membership ADMIN secara atomic. Kalau sudah
   * punya, pakai membership yang paling baru diakses (F0: "organisasi
   * terakhir yang dipakai").
   */
  private async ensureMembership(user: User) {
    const existing = await this.prisma.membership.findFirst({
      where: { userId: user.id, status: 'ACTIVE' },
      orderBy: { lastAccessedAt: 'desc' },
    });

    if (existing) {
      return this.prisma.membership.update({
        where: { id: existing.id },
        data: { lastAccessedAt: new Date() },
      });
    }

    this.logger.info(
      `no active membership for user=${user.id}, provisioning organization (D2 self-serve)`,
    );

    return this.prisma.$transaction(async (tx) => {
      const seed = user.name ?? user.email.split('@')[0];
      const slug = await this.slugService.generateUniqueOrgSlug(tx, seed);

      const organization = await tx.organization.create({
        data: {
          name: `${seed}'s Organization`,
          slug,
          createdBy: user.id,
        },
      });

      return tx.membership.create({
        data: {
          userId: user.id,
          organizationId: organization.id,
          role: Role.ADMIN,
          status: 'ACTIVE',
          lastAccessedAt: new Date(),
        },
      });
    });
  }
}
