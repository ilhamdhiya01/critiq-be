import { Controller, Get, Req, Res, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { User } from '../../generated/prisma/client';
import { AuthService } from './auth.service';

interface AuthenticatedRequest extends Request {
  user: User;
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
    const { user } = req;
    const token = this.authService.issueSessionToken(user);

    res.cookie('session', token, {
      httpOnly: true,
      secure: this.configService.get('nodeEnv') === 'production',
      sameSite: 'lax',
      maxAge: 24 * 60 * 60 * 1000,
    });
    res.redirect(this.configService.getOrThrow<string>('feUrl'));
  }
}
