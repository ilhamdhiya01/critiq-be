import { applyDecorators, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { OrgRoles } from './org-roles.decorator';
import { OrgRolesGuard } from '../guards/org-roles.guard';
import { Role } from '../../generated/prisma/enums';

export function OrgAuth(roles: Role[] = []) {
  return applyDecorators(
    UseGuards(AuthGuard('jwt'), OrgRolesGuard),
    OrgRoles(roles),
  );
}
