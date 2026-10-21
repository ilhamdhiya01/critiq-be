import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '../../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { OrgRolesGuard } from './org-roles.guard';

jest.mock('../prisma/prisma.service', () => ({ PrismaService: class {} }));

const ORG = 'org_1';
const USER = 'user_1';

interface Scenario {
  requiredRoles: Role[];
  membership: { role: Role; status: string } | null;
  params: Record<string, string>;
  // What the token claims — the guard must never rely on it.
  tokenClaims: { activeOrgId: string; role: Role };
}

function setup(scenario: Partial<Scenario> = {}) {
  const { requiredRoles, membership, params, tokenClaims }: Scenario = {
    requiredRoles: [],
    membership: { role: Role.ADMIN, status: 'ACTIVE' },
    params: { orgId: ORG },
    tokenClaims: { activeOrgId: 'org_other', role: Role.ADMIN },
    ...scenario,
  };
  const prisma = {
    membership: { findUnique: jest.fn().mockResolvedValue(membership) },
  };
  const reflector = {
    getAllAndOverride: jest.fn().mockReturnValue(requiredRoles),
  };
  const guard = new OrgRolesGuard(
    reflector as unknown as Reflector,
    prisma as unknown as PrismaService,
  );
  const request = { params, user: { sub: USER, ...tokenClaims } };
  const context = {
    getHandler: () => 'handler',
    getClass: () => 'class',
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { guard, context, prisma };
}

describe('OrgRolesGuard', () => {
  it('lets an active member through when the route needs no role', async () => {
    const { guard, context } = setup({
      membership: { role: Role.VIEWER, status: 'ACTIVE' },
    });
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  // CLAUDE.md "Multi-tenancy": membership is re-read for the :orgId in the
  // URL, never taken from the token's activeOrgId/role.
  it('checks the membership of the :orgId in the URL, not the token org', async () => {
    const { guard, context, prisma } = setup();
    await guard.canActivate(context);
    expect(prisma.membership.findUnique).toHaveBeenCalledWith({
      where: { userId_organizationId: { userId: USER, organizationId: ORG } },
    });
  });

  it('rejects a token that claims ADMIN when the membership says VIEWER', async () => {
    const { guard, context } = setup({
      requiredRoles: [Role.ADMIN],
      membership: { role: Role.VIEWER, status: 'ACTIVE' },
      tokenClaims: { activeOrgId: ORG, role: Role.ADMIN },
    });
    await expect(guard.canActivate(context)).rejects.toThrow(
      ForbiddenException,
    );
  });

  // CLAUDE.md "Role Viewer": read-only, enforced at the guard.
  it.each([
    [[Role.ADMIN], Role.REVIEWER],
    [[Role.ADMIN, Role.REVIEWER], Role.VIEWER],
  ])('requires one of %p, refusing %s', async (requiredRoles, role) => {
    const { guard, context } = setup({
      requiredRoles,
      membership: { role, status: 'ACTIVE' },
    });
    await expect(guard.canActivate(context)).rejects.toThrow(
      'This action requires one of the following roles',
    );
  });

  it('accepts any of the required roles', async () => {
    const { guard, context } = setup({
      requiredRoles: [Role.ADMIN, Role.REVIEWER],
      membership: { role: Role.REVIEWER, status: 'ACTIVE' },
    });
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it.each([
    ['not a member', null],
    ['an inactive membership', { role: Role.ADMIN, status: 'INVITED' }],
  ])('rejects %s', async (_, membership) => {
    const { guard, context } = setup({ membership });
    await expect(guard.canActivate(context)).rejects.toThrow(
      'You are not a member of this organization.',
    );
  });

  it('rejects a route without an :orgId before touching the database', async () => {
    const { guard, context, prisma } = setup({ params: {} });
    await expect(guard.canActivate(context)).rejects.toThrow(
      'Organization context is required for this route.',
    );
    expect(prisma.membership.findUnique).not.toHaveBeenCalled();
  });
});
