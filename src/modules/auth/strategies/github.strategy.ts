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
      clientID: configService.getOrThrow<string>('GITHUB_CLIENT_ID'),
      clientSecret: configService.getOrThrow<string>('GITHUB_CLIENT_SECRET'),
      callbackURL: configService.getOrThrow<string>('REDIRECT_URL'),
      scope: ['user:email', 'repo'],
    });
  }

  async validate(accessToken: string, refreshToken: string, profile: Profile) {
    const email = profile.emails?.[0]?.value;
    if (!email) {
      throw new UnprocessableEntityException(
        'GitHub profile has no public email. Please make your email public on GitHub and try again.',
      );
    }

    return this.authService.findOrCreateFromOAuth({
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
