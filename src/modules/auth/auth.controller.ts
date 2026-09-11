import { Controller, Get, Req, Res, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { Role, User } from '../../generated/prisma/client';
import { AuthService } from './auth.service';
import type { JwtPayload } from './auth.service';
import { ResponseMessage } from '../../common/decorators/response-message.decorator';

interface AuthenticatedRequest extends Request {
  user: { user: User; activeOrgId: string | null; role: Role | null };
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
  @UseGuards(AuthGuard('gitlab'))
  gitlabCallback(@Req() req: AuthenticatedRequest, @Res() res: Response): void {
    this.handleOAuthCallback(req.user, res);
  }

  @Get('me')
  @UseGuards(AuthGuard('jwt'))
  @ResponseMessage('Current session retrieved successfully')
  me(@Req() req: RequestWithSession): JwtPayload {
    return req.user;
  }

  private handleOAuthCallback(
    auth: { user: User; activeOrgId: string | null; role: Role | null },
    res: Response,
  ): void {
    const token = this.authService.issueSessionToken(
      auth.user.id,
      auth.activeOrgId,
      auth.role,
    );

    // SameSite=None + Secure:true unconditionally: user's explicit choice to
    // run FE/BE cross-origin locally instead of same-origin via proxy — see
    // main.ts for the full rationale and the local HTTPS cert this depends
    // on.
    res.cookie('session', token, {
      httpOnly: true,
      secure: true,
      sameSite: 'none',
      maxAge: 24 * 60 * 60 * 1000,
    });

    const feUrl = this.configService.getOrThrow<string>('feUrl');
    res.redirect(`${feUrl}`);
  }
}
