import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import type { Request, Response } from 'express';
import { OrganizationsService } from './organizations.service';
import { CreateOrganizationDto } from './dto/create-organization.dto';
import { UpdateOrganizationDto } from './dto/update-organization.dto';
import { AuthService, JwtPayload } from '../auth/auth.service';
import { OrgAuth } from '../../common/decorators/org-auth.decorator';
import { Role } from '../../generated/prisma/enums';

interface RequestWithSession extends Request {
  user: JwtPayload;
}

@Controller()
export class OrganizationsController {
  constructor(
    private readonly organizationsService: OrganizationsService,
    private readonly authService: AuthService,
  ) {}

  @Get('me/orgs')
  @UseGuards(AuthGuard('jwt'))
  myOrgs(@Req() req: RequestWithSession) {
    return this.organizationsService.listForUser(req.user.sub);
  }

  @Post('orgs')
  @UseGuards(AuthGuard('jwt'))
  async create(
    @Req() req: RequestWithSession,
    @Body() dto: CreateOrganizationDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { organization, role } = await this.organizationsService.create(
      req.user.sub,
      dto,
    );

    const token = this.authService.issueSessionToken(
      req.user.sub,
      organization.id,
      role,
    );
    // Kept in sync with auth.controller.ts's session cookie settings.
    res.cookie('session', token, {
      httpOnly: true,
      secure: true,
      sameSite: 'none',
      maxAge: 24 * 60 * 60 * 1000,
    });

    return organization;
  }

  // Rename an existing organization — e.g. the onboarding wizard's step 1
  // going Back then Continue again after the org was already created via
  // POST /orgs. This is a plain rename, not a second organization: PRD D1
  // (one user, many organizations) means POST /orgs must always create a
  // new row, so revising a name already submitted has to go through this
  // endpoint instead, keyed by the organization id the FE already has.
  @Patch('orgs/:orgId')
  @OrgAuth([Role.ADMIN])
  update(@Param('orgId') orgId: string, @Body() dto: UpdateOrganizationDto) {
    return this.organizationsService.update(orgId, dto);
  }
}
