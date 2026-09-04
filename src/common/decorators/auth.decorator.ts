import { applyDecorators, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Roles } from './roles.decorator';
import { RolesGuard } from '../guards/roles.guard';
import { Role } from '../../generated/prisma/enums';

export function Auth(roles: Role[] = []) {
  return applyDecorators(UseGuards(AuthGuard('jwt'), RolesGuard), Roles(roles));
}
