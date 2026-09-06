import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { HttpService } from '@nestjs/axios';
import { Strategy } from 'passport-oauth2';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../auth.service';
import { Provider } from '../../../generated/prisma/enums';

interface GitlabProfile {
  id: number;
  username: string;
  name: string;
  email: string;
  avatar_url: string;
}

@Injectable()
export class GitlabStrategy extends PassportStrategy(Strategy, 'gitlab') {
  constructor(
    configService: ConfigService,
    private readonly authService: AuthService,
    private readonly http: HttpService,
  ) {
    super({
      authorizationURL: 'https://gitlab.com/oauth/authorize',
      tokenURL: 'https://gitlab.com/oauth/token',
      clientID: configService.getOrThrow<string>('gitlab.clientId'),
      clientSecret: configService.getOrThrow<string>('gitlab.clientSecret'),
      callbackURL: configService.getOrThrow<string>('gitlab.redirectUrl'),
      scope: ['read_user'],
    });
  }

  userProfile(
    accessToken: string,
    done: (err?: Error | null, profile?: GitlabProfile) => void,
  ): void {
    firstValueFrom(
      this.http.get<GitlabProfile>('https://gitlab.com/api/v4/user', {
        headers: { Authorization: `Bearer ${accessToken}` },
      }),
    )
      .then((res) => done(null, res.data))
      .catch((err: Error) => done(err));
  }

  async validate(
    accessToken: string,
    refreshToken: string,
    profile: GitlabProfile,
  ) {
    if (!profile.email) {
      throw new UnprocessableEntityException(
        'GitLab profile has no public email. Please make your email public on GitLab and try again.',
      );
    }

    return this.authService.loginWithOAuth({
      provider: Provider.GITLAB,
      providerAccountId: String(profile.id),
      email: profile.email,
      name: profile.name ?? profile.username,
      avatarUrl: profile.avatar_url,
      accessToken,
      refreshToken,
    });
  }
}
