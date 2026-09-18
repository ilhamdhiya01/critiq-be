import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { Strategy } from 'passport-oauth2';
import { AuthService } from '../auth.service';
import { Provider } from '../../../generated/prisma/enums';

interface GitlabUserProfile {
  id: number;
  username: string;
  name: string;
  email: string;
  avatar_url: string;
}

// Identity-only login (PRD v1.4/D3): one fixed OAuth app on gitlab.com, known
// at boot time — unlike v1.3, there's no per-instance dynamism to accommodate,
// so a real Passport strategy works here instead of the hand-rolled flow that
// used to live in AuthController. `passport-oauth2` is used directly (rather
// than the unmaintained, un-typed `passport-gitlab2`) with a custom
// userProfile() hitting GitLab's API, mirroring GithubStrategy's shape.
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
    done: (err?: unknown, profile?: GitlabUserProfile) => void,
  ): void {
    firstValueFrom(
      this.http.get<GitlabUserProfile>('https://gitlab.com/api/v4/user', {
        headers: { Authorization: `Bearer ${accessToken}` },
      }),
    )
      .then((response) => done(undefined, response.data))
      .catch((error: unknown) => done(error));
  }

  async validate(
    accessToken: string,
    refreshToken: string,
    profile: GitlabUserProfile,
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
    });
  }
}
