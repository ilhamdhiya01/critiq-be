import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { ORG_ROLES_KEY } from '../decorators/org-roles.decorator';
import { Role } from '../../generated/prisma/enums';
import { JwtPayload } from '../../modules/auth/auth.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Verifies membership + role against the DB for the :orgId in the route,
 * on every request. Cannot trust JwtPayload.role alone here: that role is
 * only valid for the org that was active when the token was issued, but
 * routes are scoped to whatever :orgId is in the URL (which may differ,
 * e.g. after an org switch without token reissue). Cost is one indexed
 * lookup on the Membership unique composite key — cheap compared to the
 * cross-tenant authorization bug this prevents.
 */
@Injectable()
export class OrgRolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredRoles = this.reflector.getAllAndOverride<Role[]>(
      ORG_ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    const request = context
      .switchToHttp()
      .getRequest<Request & { user: JwtPayload }>();

    const orgId = request.params.orgId;
    if (!orgId || typeof orgId !== 'string') {
      throw new ForbiddenException(
        'Organization context is required for this route.',
      );
    }

    const membership = await this.prisma.membership.findUnique({
      where: {
        userId_organizationId: {
          userId: request.user.sub,
          organizationId: orgId,
        },
      },
    });

    if (!membership || membership.status !== 'ACTIVE') {
      throw new ForbiddenException(
        'You are not a member of this organization.',
      );
    }

    if (
      requiredRoles &&
      requiredRoles.length > 0 &&
      !requiredRoles.includes(membership.role)
    ) {
      throw new ForbiddenException(
        `This action requires one of the following roles: ${requiredRoles.join(', ')}`,
      );
    }

    return true;
  }
}
