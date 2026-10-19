import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { OrgAuth } from '../../common/decorators/org-auth.decorator';
import { ResponseMessage } from '../../common/decorators/response-message.decorator';
import { Role } from '../../generated/prisma/enums';
import type { JwtPayload } from '../auth/auth.service';
import { CreateInviteDto, UpdateMemberRoleDto } from './dto/members.dto';
import { MembersService } from './members.service';

interface RequestWithSession extends Request {
  user: JwtPayload;
}

// Settings → Members. Reading is open to every role; every change is
// Admin only.
@Controller('orgs/:orgId/members')
export class MembersController {
  constructor(private readonly membersService: MembersService) {}

  @Get()
  @OrgAuth([])
  @ResponseMessage('Members retrieved successfully')
  list(@Param('orgId') orgId: string, @Req() req: RequestWithSession) {
    return this.membersService.list(orgId, req.user.sub);
  }

  @Post('invites')
  @OrgAuth([Role.ADMIN])
  @ResponseMessage('Invitation created')
  invite(
    @Param('orgId') orgId: string,
    @Req() req: RequestWithSession,
    @Body() dto: CreateInviteDto,
  ) {
    return this.membersService.invite(orgId, req.user.sub, dto);
  }

  @Post('invites/:invitationId/resend')
  @OrgAuth([Role.ADMIN])
  @ResponseMessage('Invitation sent again')
  resend(
    @Param('orgId') orgId: string,
    @Param('invitationId') invitationId: string,
    @Req() req: RequestWithSession,
  ) {
    return this.membersService.resend(orgId, req.user.sub, invitationId);
  }

  @Delete('invites/:invitationId')
  @OrgAuth([Role.ADMIN])
  @ResponseMessage('Invitation revoked')
  revoke(
    @Param('orgId') orgId: string,
    @Param('invitationId') invitationId: string,
    @Req() req: RequestWithSession,
  ) {
    return this.membersService.revoke(orgId, req.user.sub, invitationId);
  }

  @Patch(':userId')
  @OrgAuth([Role.ADMIN])
  @ResponseMessage('Member role updated')
  changeRole(
    @Param('orgId') orgId: string,
    @Param('userId') userId: string,
    @Req() req: RequestWithSession,
    @Body() dto: UpdateMemberRoleDto,
  ) {
    return this.membersService.changeRole(
      orgId,
      req.user.sub,
      userId,
      dto.role,
    );
  }

  @Delete(':userId')
  @OrgAuth([Role.ADMIN])
  @ResponseMessage('Member removed')
  remove(
    @Param('orgId') orgId: string,
    @Param('userId') userId: string,
    @Req() req: RequestWithSession,
  ) {
    return this.membersService.remove(orgId, req.user.sub, userId);
  }
}
