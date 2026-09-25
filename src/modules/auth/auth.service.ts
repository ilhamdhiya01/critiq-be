import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../../common/prisma/prisma.service';
import { Provider, Role, User } from '../../generated/prisma/client';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import { Logger } from 'winston';
import { SessionUserDto } from './dto/session-user.dto';

export interface JwtPayload {
  sub: string;
  activeOrgId: string | null;
  role: Role | null;
  provider: Provider;
  // Onboarding state of `activeOrgId` only — like `role`, it is scoped to
  // the organization the token was issued for, not the user globally (D1:
  // one user can belong to several organizations, each with its own
  // onboarding state). Any endpoint that changes which org is active, or
  // that completes onboarding, must reissue the token — see
  // ReposController.createRepos and OrganizationsController.create.
  onboardingCompleted: boolean;
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

  // Takes an object rather than positional arguments: the payload now has
  // several same-typed fields (two nullable strings, two booleans-or-enums)
  // that are easy to transpose silently at a call site.
  issueSessionToken(payload: JwtPayload): string {
    return this.jwtService.sign(payload);
  }

  // Backs GET /auth/me. Profile fields (email/name/avatarUrl) always come
  // from a fresh DB read here — see SessionUserDto's own comment for why
  // they're deliberately never embedded in the token itself. Session-scoped
  // fields (activeOrgId/role/onboardingCompleted) still come from the
  // payload, not re-derived — same rationale as OrgRolesGuard re-verifying
  // role per :orgId, but there is no :orgId on this route to re-verify
  // against.
  async getSessionUser(payload: JwtPayload): Promise<SessionUserDto> {
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
    });
    if (!user) {
      // Token references a user that no longer exists (deleted between
      // issue and this request) — treat exactly like an invalid token.
      throw new UnauthorizedException('Invalid session token');
    }
    return new SessionUserDto({
      id: user.id,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl,
      activeOrgId: payload.activeOrgId,
      role: payload.role,
      provider: payload.provider,
      onboardingCompleted: payload.onboardingCompleted,
    });
  }

  async loginWithOAuth(profile: OAuthProfile): Promise<{
    user: User;
    activeOrgId: string | null;
    role: Role | null;
    provider: Provider;
    onboardingCompleted: boolean;
  }> {
    const user = await this.findOrCreateUser(profile);
    // `organization` is included for its onboardingCompleted flag, which
    // rides in the session token so the FE can route a fresh login straight
    // past the setup wizard without a second round trip.
    const membership = await this.prisma.membership.findFirst({
      where: { userId: user.id, status: 'ACTIVE' },
      orderBy: { lastAccessedAt: 'desc' },
      include: { organization: true },
    });
    return {
      user,
      activeOrgId: membership?.organizationId ?? null,
      role: membership?.role ?? null,
      provider: profile.provider,
      // A user with no membership at all has no organization to be onboarded
      // into yet, so `false` sends them to the wizard — the same place the
      // flag's default sends a brand-new organization.
      onboardingCompleted:
        membership?.organization.onboardingCompleted ?? false,
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
