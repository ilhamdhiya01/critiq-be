import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import type { Request } from 'express';
import { OrganizationsService } from './organizations.service';
import { CreateOrganizationDto } from './dto/create-organization.dto';
import { JwtPayload } from '../auth/auth.service';

interface RequestWithSession extends Request {
  user: JwtPayload;
}

@Controller()
export class OrganizationsController {
  constructor(private readonly organizationsService: OrganizationsService) {}

  @Get('me/orgs')
  @UseGuards(AuthGuard('jwt'))
  myOrgs(@Req() req: RequestWithSession) {
    return this.organizationsService.listForUser(req.user.sub);
  }

  @Post('orgs')
  @UseGuards(AuthGuard('jwt'))
  create(@Req() req: RequestWithSession, @Body() dto: CreateOrganizationDto) {
    return this.organizationsService.create(req.user.sub, dto);
  }
}
