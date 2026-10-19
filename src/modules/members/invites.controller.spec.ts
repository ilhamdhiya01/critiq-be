import type { Request, Response } from 'express';
import { Role } from '../../generated/prisma/enums';
import { AuthService, type JwtPayload } from '../auth/auth.service';
import { InvitesController } from './invites.controller';
import { MembersService } from './members.service';

// @nestjs/passport ships an ESM-only build this CommonJS Jest setup cannot
// load; the guard is not what these tests are about.
jest.mock('@nestjs/passport', () => ({ AuthGuard: () => class {} }));
jest.mock('../auth/auth.service', () => ({ AuthService: class {} }));
jest.mock('./members.service', () => ({ MembersService: class {} }));

describe('InvitesController.accept', () => {
  it('switches the session to the organization joined', async () => {
    const members = {
      accept: jest.fn().mockResolvedValue({
        organization: {
          id: 'org_1',
          name: 'Acme',
          slug: 'acme',
          onboardingCompleted: true,
        },
        role: Role.REVIEWER,
      }),
    };
    const auth = { issueSessionToken: jest.fn().mockReturnValue('jwt') };
    const res = { cookie: jest.fn() };
    const controller = new InvitesController(
      members as unknown as MembersService,
      auth as unknown as AuthService,
    );

    const result = await controller.accept(
      'tok',
      { user: { sub: 'u_1', provider: 'GITHUB' } as JwtPayload } as Request & {
        user: JwtPayload;
      },
      res as unknown as Response,
    );

    expect(auth.issueSessionToken).toHaveBeenCalledWith({
      sub: 'u_1',
      activeOrgId: 'org_1',
      role: Role.REVIEWER,
      provider: 'GITHUB',
      onboardingCompleted: true,
    });
    expect(res.cookie).toHaveBeenCalledWith(
      'session',
      'jwt',
      expect.objectContaining({ httpOnly: true, secure: true }),
    );
    expect(result).toEqual({
      organization: { id: 'org_1', name: 'Acme', slug: 'acme' },
      role: 'reviewer',
    });
  });
});
