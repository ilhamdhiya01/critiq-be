import { Controller, Get, Req, Res, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { Role, User } from '../../generated/prisma/client';
import { AuthService } from './auth.service';
import type { JwtPayload } from './auth.service';

interface AuthenticatedRequest extends Request {
  user: { user: User; activeOrgId: string; role: Role };
}

interface RequestWithSession extends Request {
  user: JwtPayload;
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
  ) {}

  @Get('github')
  @UseGuards(AuthGuard('github'))
  githubLogin(): void {
    // Passport intercepts this and redirects to GitHub's consent screen.
    // This method body never runs.
  }

  @Get('github/callback')
  @UseGuards(AuthGuard('github'))
  githubCallback(@Req() req: AuthenticatedRequest, @Res() res: Response): void {
    // Deliberately uses @Res() (not `return`) because this endpoint is a
    // browser redirect flow (GitHub -> BE -> eventually FE + httpOnly
    // cookie), not an endpoint called via fetch/AJAX from the FE — so it
    // needs manual control over the response instead of returning a plain
    // value like the other controllers do.
    this.handleOAuthCallback(req.user, res);
  }

  @Get('gitlab')
  @UseGuards(AuthGuard('gitlab'))
  gitlabLogin(): void {
    // Passport intercepts this and redirects to GitLab's consent screen.
    // This method body never runs.
  }

  @Get('gitlab/callback')
  @UseGuards(AuthGuard('gitlab'))
  gitlabCallback(@Req() req: AuthenticatedRequest, @Res() res: Response): void {
    this.handleOAuthCallback(req.user, res);
  }

  @Get('me')
  @UseGuards(AuthGuard('jwt'))
  me(@Req() req: RequestWithSession): JwtPayload {
    return req.user;
  }

  private handleOAuthCallback(
    auth: { user: User; activeOrgId: string; role: Role },
    res: Response,
  ): void {
    const token = this.authService.issueSessionToken(
      auth.user,
      auth.activeOrgId,
      auth.role,
    );

    res.cookie('session', token, {
      httpOnly: true,
      secure: this.configService.get('nodeEnv') === 'production',
      sameSite: 'lax',
      maxAge: 24 * 60 * 60 * 1000,
    });
    res.redirect(this.configService.getOrThrow<string>('feUrl'));
  }
}
