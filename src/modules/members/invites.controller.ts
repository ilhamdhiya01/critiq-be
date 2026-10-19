import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import type { Request, Response } from 'express';
import { ResponseMessage } from '../../common/decorators/response-message.decorator';
import { AuthService, type JwtPayload } from '../auth/auth.service';
import { setSessionCookie } from '../auth/session-cookie';
import { AcceptedInviteDto, toWireRole } from './dto/members.dto';
import { MembersService } from './members.service';

interface RequestWithSession extends Request {
  user: JwtPayload;
}

// The invitee's side of an invitation — no organization in the URL: the
// link's token decides which one.
@Controller('invites')
export class InvitesController {
  constructor(
    private readonly membersService: MembersService,
    private readonly authService: AuthService,
  ) {}

  // Public: the invite page shows it before the invitee signs in.
  @Get(':token')
  @ResponseMessage('Invitation retrieved successfully')
  preview(@Param('token') token: string) {
    return this.membersService.preview(token);
  }

  // Joins, then switches the session to that organization (like creating
  // one does) so the invitee lands in it.
  @Post(':token/accept')
  @UseGuards(AuthGuard('jwt'))
  @HttpCode(HttpStatus.OK)
  @ResponseMessage('Invitation accepted')
  async accept(
    @Param('token') token: string,
    @Req() req: RequestWithSession,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AcceptedInviteDto> {
    const joined = await this.membersService.accept(token, req.user.sub);
    setSessionCookie(
      res,
      this.authService.issueSessionToken({
        sub: req.user.sub,
        activeOrgId: joined.organization.id,
        role: joined.role,
        provider: req.user.provider,
        onboardingCompleted: joined.organization.onboardingCompleted,
      }),
    );
    return new AcceptedInviteDto({
      organization: {
        id: joined.organization.id,
        name: joined.organization.name,
        slug: joined.organization.slug,
      },
      role: toWireRole(joined.role),
    });
  }
}
