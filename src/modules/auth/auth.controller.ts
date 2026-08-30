import { Controller, Get, Req, Res, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import type { Request, Response } from 'express';
import { WebResponse } from '../../common/types/web-response';
import { User } from '../../generated/prisma/client';

interface AuthenticatedRequest extends Request {
  user: User;
}

@Controller('auth')
export class AuthController {
  @Get('github')
  @UseGuards(AuthGuard('github'))
  githubLogin() {
    // Passport intercepts this and redirects to GitHub's consent screen.
    // This method body never runs.
  }

  @Get('github/callback')
  @UseGuards(AuthGuard('github'))
  githubCallback(@Req() req: AuthenticatedRequest, @Res() res: Response) {
    // Deliberately uses @Res() (not `return`) because this endpoint is a
    // browser redirect flow (GitHub -> BE -> eventually FE + httpOnly
    // cookie), not an endpoint called via fetch/AJAX from the FE — so it
    // needs manual control over the response instead of returning a plain
    // value like the other controllers do.
    //
    // TODO (next step): issue JWT session, res.cookie(...) httpOnly,
    // res.redirect(<FE_URL>) instead of res.json(...).
    const { user } = req;
    const body: WebResponse<Pick<User, 'id' | 'email' | 'name'>> = {
      data: { id: user.id, email: user.email, name: user.name },
    };
    res.json(body);
  }
}
