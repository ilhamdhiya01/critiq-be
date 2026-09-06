import { SetMetadata } from '@nestjs/common';
import { Role } from '../../generated/prisma/enums';

export const ORG_ROLES_KEY = 'orgRoles';
export const OrgRoles = (roles: Role[]) => SetMetadata(ORG_ROLES_KEY, roles);
