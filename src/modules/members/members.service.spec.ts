import { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import { Logger } from 'winston';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RealtimePublisher } from '../../common/realtime/realtime.publisher';
import { RateLimiterService } from '../../common/redis/rate-limiter.service';
import {
  InvitationEmailStatus,
  MembershipStatus,
  Role,
} from '../../generated/prisma/enums';
import type { EmailJobPayload } from '../../queue/email-queue.constants';
import { hashInvitationToken, newInvitationToken } from './invitation-token';
import { MembersService } from './members.service';

jest.mock('../../common/prisma/prisma.service', () => ({
  PrismaService: class {},
}));
jest.mock('../../common/realtime/realtime.publisher', () => ({
  RealtimePublisher: class {},
}));
jest.mock('../../common/redis/rate-limiter.service', () => ({
  RateLimiterService: class {},
}));
jest.mock('@nestjs/bullmq', () => ({ InjectQueue: () => () => undefined }));
jest.mock('@nestjs/config', () => ({ ConfigService: class {} }));

const ORG = 'org_1';
const ADMIN = 'u_admin';
const FUTURE = new Date(Date.now() + 86_400_000);
const PAST = new Date(Date.now() - 1000);

function invitationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'inv_1',
    organizationId: ORG,
    email: 'kantor@perusahaan.com',
    role: Role.REVIEWER,
    tokenHash: 'hash',
    invitedById: ADMIN,
    expiresAt: FUTURE,
    acceptedAt: null,
    acceptedById: null,
    revokedAt: null,
    emailStatus: InvitationEmailStatus.PENDING,
    emailError: null,
    createdAt: new Date('2026-10-19T00:00:00Z'),
    updatedAt: new Date('2026-10-19T00:00:00Z'),
    invitedBy: { id: ADMIN, name: 'Alex Winter', email: 'alex@x.io' },
    organization: {
      id: ORG,
      name: 'Acme',
      slug: 'acme',
      onboardingCompleted: true,
    },
    ...overrides,
  };
}

function memberRow(userId: string, role: Role) {
  return {
    id: `m_${userId}`,
    userId,
    organizationId: ORG,
    role,
    status: MembershipStatus.ACTIVE,
    createdAt: new Date('2026-10-01T00:00:00Z'),
    user: {
      id: userId,
      name: userId,
      email: `${userId}@x.io`,
      avatarUrl: null,
    },
  };
}

function setup(options: { mailHost?: string } = {}) {
  const prisma = {
    membership: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue(null),
      update: jest.fn(),
      upsert: jest.fn().mockResolvedValue({}),
      delete: jest.fn().mockResolvedValue({}),
    },
    invitation: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue(null),
      findUniqueOrThrow: jest.fn(),
      create: jest.fn((args: { data: Record<string, unknown> }) =>
        Promise.resolve(invitationRow(args.data)),
      ),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    user: { findUnique: jest.fn().mockResolvedValue({ email: 'me@x.io' }) },
    $queryRaw: jest.fn().mockResolvedValue([]),
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation(
    (fn: (tx: typeof prisma) => Promise<unknown>) => fn(prisma),
  );
  const config = {
    get: (key: string) =>
      key === 'mail.host'
        ? (options.mailHost ?? 'smtp.sumopod.com')
        : undefined,
    getOrThrow: () => 'https://critiq-dev.web.id',
  };
  const rateLimiter = { tryConsume: jest.fn().mockResolvedValue(true) };
  const realtime = { publish: jest.fn() };
  const queue = { add: jest.fn().mockResolvedValue({}) };
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const service = new MembersService(
    prisma as unknown as PrismaService,
    config as unknown as ConfigService,
    rateLimiter as unknown as RateLimiterService,
    realtime as unknown as RealtimePublisher,
    queue as unknown as Queue<EmailJobPayload>,
    logger as unknown as Logger,
  );
  return { service, prisma, rateLimiter, realtime, queue, logger };
}

const membersArea = { type: 'settings.updated', orgId: ORG, area: 'members' };

describe('MembersService.list', () => {
  it('shows pending invitations to Admins only', async () => {
    const { service, prisma } = setup();
    prisma.membership.findMany.mockResolvedValue([
      memberRow(ADMIN, Role.ADMIN),
      memberRow('u_viewer', Role.VIEWER),
    ]);
    prisma.invitation.findMany.mockResolvedValue([invitationRow()]);

    const asAdmin = await service.list(ORG, ADMIN);
    expect(asAdmin.invites).toHaveLength(1);
    expect(asAdmin.members[0]).toMatchObject({ role: 'admin', isYou: true });

    prisma.invitation.findMany.mockClear();
    const asViewer = await service.list(ORG, 'u_viewer');
    expect(asViewer.invites).toBeNull();
    expect(prisma.invitation.findMany).not.toHaveBeenCalled();
  });
});

describe('MembersService.invite', () => {
  it('stores the hash, queues the email and returns the link once', async () => {
    const { service, prisma, queue, realtime } = setup();
    const result = await service.invite(ORG, ADMIN, {
      email: 'Kantor@Perusahaan.com ',
      role: 'reviewer',
    });

    const [{ data }] = prisma.invitation.create.mock.calls[0] as [
      { data: Record<string, unknown> },
    ];
    const token = result.inviteUrl.split('/invite/')[1];
    expect(data).toMatchObject({
      organizationId: ORG,
      email: 'kantor@perusahaan.com',
      role: Role.REVIEWER,
      tokenHash: hashInvitationToken(token),
      invitedById: ADMIN,
      emailStatus: InvitationEmailStatus.PENDING,
    });
    expect(JSON.stringify(data)).not.toContain(token);
    expect(queue.add).toHaveBeenCalledWith(
      'invitation',
      { kind: 'invitation', invitationId: 'inv_1', token },
      expect.objectContaining({ removeOnComplete: true, removeOnFail: true }),
    );
    expect(result.invite).toMatchObject({
      role: 'reviewer',
      delivery: { status: 'pending' },
    });
    expect(realtime.publish).toHaveBeenCalledWith(membersArea);
  });

  // Local dev / no SMTP: the Admin shares the link by hand.
  it('creates the invitation without queueing when mail is not configured', async () => {
    const { service, prisma, queue } = setup({ mailHost: '' });
    const result = await service.invite(ORG, ADMIN, {
      email: 'a@x.io',
      role: 'viewer',
    });
    expect(prisma.invitation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          emailStatus: InvitationEmailStatus.NOT_CONFIGURED,
        }) as unknown,
      }),
    );
    expect(queue.add).not.toHaveBeenCalled();
    expect(result.inviteUrl).toMatch(
      /^https:\/\/critiq-dev\.web\.id\/invite\//,
    );
  });

  it('keeps the invitation, marked failed, when the queue is down', async () => {
    const { service, prisma, queue } = setup();
    queue.add.mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await service.invite(ORG, ADMIN, {
      email: 'a@x.io',
      role: 'viewer',
    });
    expect(prisma.invitation.update).toHaveBeenCalledWith({
      where: { id: 'inv_1' },
      data: {
        emailStatus: InvitationEmailStatus.FAILED,
        emailError: 'queue_unavailable',
      },
    });
    expect(result.invite.delivery).toEqual({
      status: 'failed',
      error: 'queue_unavailable',
    });
  });

  it.each([
    ['already_member', 'membership', 409],
    ['invite_pending', 'invitation', 409],
  ])('refuses with %s', async (message, model, status) => {
    const { service, prisma } = setup();
    prisma[model as 'membership' | 'invitation'].findFirst.mockResolvedValue({
      id: 'x',
    });
    await expect(
      service.invite(ORG, ADMIN, { email: 'a@x.io', role: 'viewer' }),
    ).rejects.toMatchObject({ status, response: { message } });
    expect(prisma.invitation.create).not.toHaveBeenCalled();
  });

  it('429s past 20 invitations an hour', async () => {
    const { service, rateLimiter, prisma } = setup();
    rateLimiter.tryConsume.mockResolvedValue(false);
    await expect(
      service.invite(ORG, ADMIN, { email: 'a@x.io', role: 'viewer' }),
    ).rejects.toMatchObject({
      status: 429,
      response: { message: 'invite_rate_limited' },
    });
    expect(rateLimiter.tryConsume).toHaveBeenCalledWith(
      `ratelimit:invite:org:${ORG}`,
      20,
      3600,
    );
    expect(prisma.invitation.create).not.toHaveBeenCalled();
  });
});

describe('MembersService.resend / revoke', () => {
  it('replaces the token, so the old link stops working', async () => {
    const { service, prisma, queue } = setup();
    prisma.invitation.findUnique.mockResolvedValue(invitationRow());
    prisma.invitation.findUniqueOrThrow.mockResolvedValue(invitationRow());
    const result = await service.resend(ORG, ADMIN, 'inv_1');
    const token = result.inviteUrl.split('/invite/')[1];
    const [{ data }] = prisma.invitation.updateMany.mock.calls[0] as [
      { data: { tokenHash: string; expiresAt: Date } },
    ];
    expect(data.tokenHash).toBe(hashInvitationToken(token));
    expect(data.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(queue.add).toHaveBeenCalledWith(
      'invitation',
      expect.objectContaining({ token }),
      expect.anything(),
    );
  });

  it.each([
    [{ acceptedAt: new Date() }, 'invite_used'],
    [{ revokedAt: new Date() }, 'invite_revoked'],
  ])('does not resend a closed invitation', async (state, message) => {
    const { service, prisma } = setup();
    prisma.invitation.findUnique.mockResolvedValue(invitationRow(state));
    await expect(service.resend(ORG, ADMIN, 'inv_1')).rejects.toMatchObject({
      status: 409,
      response: { message },
    });
  });

  // Another org's invitation looks missing.
  it("404s another organization's invitation", async () => {
    const { service, prisma } = setup();
    prisma.invitation.findUnique.mockResolvedValue(
      invitationRow({ organizationId: 'org_other' }),
    );
    await expect(service.revoke(ORG, ADMIN, 'inv_1')).rejects.toMatchObject({
      status: 404,
      response: { message: 'invite_not_found' },
    });
  });

  it('revokes an open invitation', async () => {
    const { service, prisma, realtime } = setup();
    prisma.invitation.findUnique.mockResolvedValue(invitationRow());
    await expect(service.revoke(ORG, ADMIN, 'inv_1')).resolves.toEqual({
      id: 'inv_1',
    });
    expect(prisma.invitation.updateMany).toHaveBeenCalledWith({
      where: { id: 'inv_1', acceptedAt: null, revokedAt: null },
      data: { revokedAt: expect.any(Date) as Date },
    });
    expect(realtime.publish).toHaveBeenCalledWith(membersArea);
  });
});

describe('MembersService.changeRole / remove', () => {
  it('changes a role', async () => {
    const { service, prisma } = setup();
    prisma.membership.findUnique.mockResolvedValue(
      memberRow('u_2', Role.VIEWER),
    );
    prisma.membership.update.mockResolvedValue(memberRow('u_2', Role.REVIEWER));
    await expect(
      service.changeRole(ORG, ADMIN, 'u_2', 'reviewer'),
    ).resolves.toMatchObject({ userId: 'u_2', role: 'reviewer' });
  });

  // An organization always keeps one Admin.
  it('422s demoting the last Admin, locking the Admin rows first', async () => {
    const { service, prisma } = setup();
    prisma.membership.findUnique.mockResolvedValue(
      memberRow(ADMIN, Role.ADMIN),
    );
    prisma.$queryRaw.mockResolvedValue([{ userId: ADMIN }]);
    await expect(
      service.changeRole(ORG, ADMIN, ADMIN, 'viewer'),
    ).rejects.toMatchObject({
      status: 422,
      response: { message: 'last_admin' },
    });
    const [strings] = prisma.$queryRaw.mock.calls[0] as [TemplateStringsArray];
    expect(strings.join('?')).toContain('FOR UPDATE');
    expect(prisma.membership.update).not.toHaveBeenCalled();
  });

  it('lets an Admin step down while another Admin remains', async () => {
    const { service, prisma } = setup();
    prisma.membership.findUnique.mockResolvedValue(
      memberRow(ADMIN, Role.ADMIN),
    );
    prisma.$queryRaw.mockResolvedValue([{ userId: ADMIN }, { userId: 'u_2' }]);
    prisma.membership.update.mockResolvedValue(memberRow(ADMIN, Role.VIEWER));
    await expect(
      service.changeRole(ORG, ADMIN, ADMIN, 'viewer'),
    ).resolves.toMatchObject({ role: 'viewer', isYou: true });
  });

  it('422s removing the last Admin', async () => {
    const { service, prisma } = setup();
    prisma.membership.findUnique.mockResolvedValue(
      memberRow(ADMIN, Role.ADMIN),
    );
    prisma.$queryRaw.mockResolvedValue([{ userId: ADMIN }]);
    await expect(service.remove(ORG, ADMIN, ADMIN)).rejects.toMatchObject({
      status: 422,
    });
    expect(prisma.membership.delete).not.toHaveBeenCalled();
  });

  it('removes a member without the Admin check', async () => {
    const { service, prisma, realtime } = setup();
    prisma.membership.findUnique.mockResolvedValue(
      memberRow('u_2', Role.REVIEWER),
    );
    await expect(service.remove(ORG, ADMIN, 'u_2')).resolves.toEqual({
      userId: 'u_2',
    });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(prisma.membership.delete).toHaveBeenCalledWith({
      where: { id: 'm_u_2' },
    });
    expect(realtime.publish).toHaveBeenCalledWith(membersArea);
  });

  it('404s someone who is not a member', async () => {
    const { service } = setup();
    await expect(service.remove(ORG, ADMIN, 'u_9')).rejects.toMatchObject({
      status: 404,
      response: { message: 'member_not_found' },
    });
  });
});

describe('MembersService.preview / accept', () => {
  const { token } = newInvitationToken();

  it('previews with a masked email', async () => {
    const { service, prisma } = setup();
    prisma.invitation.findUnique.mockResolvedValue(invitationRow());
    await expect(service.preview(token)).resolves.toMatchObject({
      organization: { name: 'Acme', slug: 'acme' },
      invitedBy: { name: 'Alex Winter' },
      role: 'reviewer',
      email: 'ka***@perusahaan.com',
      status: 'pending',
    });
    expect(prisma.invitation.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tokenHash: hashInvitationToken(token) },
      }),
    );
  });

  it('404s a malformed token without touching the database', async () => {
    const { service, prisma } = setup();
    await expect(service.preview('../x')).rejects.toMatchObject({
      status: 404,
    });
    expect(prisma.invitation.findUnique).not.toHaveBeenCalled();
  });

  it('joins with the invited role, also signed in with another email', async () => {
    const { service, prisma, logger, realtime } = setup();
    prisma.invitation.findUnique.mockResolvedValue(invitationRow());
    const joined = await service.accept(token, 'u_new');
    expect(prisma.invitation.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: 'inv_1',
        tokenHash: 'hash',
        acceptedAt: null,
        revokedAt: null,
      }) as unknown,
      data: { acceptedAt: expect.any(Date) as Date, acceptedById: 'u_new' },
    });
    expect(prisma.membership.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: {
          userId: 'u_new',
          organizationId: ORG,
          role: Role.REVIEWER,
          status: MembershipStatus.ACTIVE,
        },
      }),
    );
    expect(joined).toMatchObject({
      organization: { id: ORG, slug: 'acme' },
      role: Role.REVIEWER,
    });
    expect(logger.info).toHaveBeenCalledWith(
      'audit.member.joined',
      expect.objectContaining({ emailMismatch: true }),
    );
    expect(realtime.publish).toHaveBeenCalledWith(membersArea);
  });

  it.each([
    [{ acceptedAt: new Date() }, 'invite_used'],
    [{ revokedAt: new Date() }, 'invite_revoked'],
    [{ expiresAt: PAST }, 'invite_expired'],
  ])('410s a closed invitation', async (state, message) => {
    const { service, prisma } = setup();
    prisma.invitation.findUnique.mockResolvedValue(invitationRow(state));
    await expect(service.accept(token, 'u_new')).rejects.toMatchObject({
      status: 410,
      response: { message },
    });
  });

  // Two accepts racing on one link: one member, the other told it is used.
  it('410s when the claim is lost', async () => {
    const { service, prisma } = setup();
    prisma.invitation.findUnique.mockResolvedValue(invitationRow());
    prisma.invitation.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.accept(token, 'u_new')).rejects.toMatchObject({
      status: 410,
      response: { message: 'invite_used' },
    });
    expect(prisma.membership.upsert).not.toHaveBeenCalled();
  });

  // The Admin who sent it opening the link while still signed in.
  it('409s an existing member without using up the link', async () => {
    const { service, prisma } = setup();
    prisma.invitation.findUnique.mockResolvedValue(invitationRow());
    prisma.membership.findUnique.mockResolvedValue({
      status: MembershipStatus.ACTIVE,
    });
    await expect(service.accept(token, 'u_new')).rejects.toMatchObject({
      status: 409,
      response: { message: 'already_member' },
    });
    expect(prisma.membership.upsert).not.toHaveBeenCalled();
    // Still valid for the person it was meant for.
    expect(prisma.invitation.updateMany).not.toHaveBeenCalled();
  });
});
