import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, Profile } from 'passport-github2';
import { AuthService } from '../auth.service';
import { Provider } from '../../../generated/prisma/enums';

@Injectable()
export class GithubStrategy extends PassportStrategy(Strategy, 'github') {
  constructor(
    configService: ConfigService,
    private readonly authService: AuthService,
  ) {
    super({
      clientID: configService.getOrThrow<string>('github.clientId'),
      clientSecret: configService.getOrThrow<string>('github.clientSecret'),
      callbackURL: configService.getOrThrow<string>('github.redirectUrl'),
      // Identity-only (PRD v1.4/D3, same principle already applied to
      // GitLab's login strategy): repo access comes from the separate
      // GitHub App installation flow (see integrations module), never from
      // this OAuth token. `repo` scope was a pre-existing leftover that
      // granted read/write access to the user's private repos via their
      // personal OAuth token — removed as part of the GitHub App migration.
      scope: ['user:email'],
    });
  }

  async validate(accessToken: string, refreshToken: string, profile: Profile) {
    const email = profile.emails?.[0]?.value;
    if (!email) {
      throw new UnprocessableEntityException(
        'GitHub profile has no public email. Please make your email public on GitHub and try again.',
      );
    }

    return this.authService.loginWithOAuth({
      provider: Provider.GITHUB,
      providerAccountId: profile.id,
      email,
      name: profile.displayName ?? profile.username,
      avatarUrl: profile.photos?.[0]?.value,
      accessToken,
      refreshToken,
    });
  }
}
