import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { Provider, Role, User } from '../../generated/prisma/client';
import { AuthService } from './auth.service';
import type { JwtPayload } from './auth.service';
import { ResponseMessage } from '../../common/decorators/response-message.decorator';
import { SessionUserDto } from './dto/session-user.dto';
import { SessionCookieService } from './session-cookie';
import {
  OAuthCallbackGuard,
  OAuthStateMismatchFilter,
} from './oauth-callback.guard';

interface AuthenticatedRequest extends Request {
  user: {
    user: User;
    activeOrgId: string | null;
    role: Role | null;
    provider: Provider;
    onboardingCompleted: boolean;
  };
}

interface RequestWithSession extends Request {
  user: JwtPayload;
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
    private readonly sessionCookie: SessionCookieService,
  ) {}

  @Get('github')
  @UseGuards(AuthGuard('github'))
  githubLogin(): void {
    // Passport intercepts this and redirects to GitHub's consent screen.
    // This method body never runs.
  }

  @Get('github/callback')
  @UseGuards(OAuthCallbackGuard('github'))
  @UseFilters(OAuthStateMismatchFilter)
  githubCallback(@Req() req: AuthenticatedRequest, @Res() res: Response): void {
    // Deliberately uses @Res() (not `return`) because this endpoint is a
    // browser redirect flow (GitHub -> BE -> eventually FE + httpOnly
    // cookie), not an endpoint called via fetch/AJAX from the FE — so it
    // needs manual control over the response instead of returning a plain
    // value like the other controllers do.
    this.handleOAuthCallback(req.user, res);
  }

  // GitLab identity login (PRD v1.4/D3): a normal static Passport strategy,
  // same shape as GitHub — one fixed gitlab.com OAuth app, scope `read_user`
  // only. Unlike v1.3, this is not hand-rolled: repo access is a separate
  // concern entirely now (org-level access token via the integrations
  // module), so there's no per-instance dynamism left to justify a manual
  // flow here.
  @Get('gitlab')
  @UseGuards(AuthGuard('gitlab'))
  gitlabLogin(): void {
    // Passport intercepts this and redirects to GitLab's consent screen.
    // This method body never runs.
  }

  @Get('gitlab/callback')
  @UseGuards(OAuthCallbackGuard('gitlab'))
  @UseFilters(OAuthStateMismatchFilter)
  gitlabCallback(@Req() req: AuthenticatedRequest, @Res() res: Response): void {
    this.handleOAuthCallback(req.user, res);
  }

  // No guard: signing out must work with an expired or missing session
  // too. The httpOnly cookie can only be removed by the server. The JWT is
  // stateless, so a copy taken elsewhere stays valid until it expires.
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ResponseMessage('Signed out')
  logout(@Res({ passthrough: true }) res: Response): { loggedOut: true } {
    this.sessionCookie.clear(res);
    return { loggedOut: true };
  }

  @Get('me')
  @UseGuards(AuthGuard('jwt'))
  @ResponseMessage('Current session retrieved successfully')
  me(@Req() req: RequestWithSession): Promise<SessionUserDto> {
    return this.authService.getSessionUser(req.user);
  }

  private handleOAuthCallback(
    auth: {
      user: User;
      activeOrgId: string | null;
      role: Role | null;
      provider: Provider;
      onboardingCompleted: boolean;
    },
    res: Response,
  ): void {
    const token = this.authService.issueSessionToken({
      sub: auth.user.id,
      activeOrgId: auth.activeOrgId,
      role: auth.role,
      provider: auth.provider,
      onboardingCompleted: auth.onboardingCompleted,
    });

    this.sessionCookie.set(res, token);

    const feUrl = this.configService.getOrThrow<string>('feUrl');
    res.redirect(`${feUrl}`);
  }
}
