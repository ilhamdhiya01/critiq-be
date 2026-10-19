import { InjectQueue } from '@nestjs/bullmq';
import {
  ConflictException,
  GoneException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import { Logger } from 'winston';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RealtimePublisher } from '../../common/realtime/realtime.publisher';
import { RateLimiterService } from '../../common/redis/rate-limiter.service';
import type { Invitation } from '../../generated/prisma/client';
import type { Prisma } from '../../generated/prisma/client';
import {
  InvitationEmailStatus,
  MembershipStatus,
  Role,
} from '../../generated/prisma/enums';
import {
  EMAIL_JOB_OPTIONS,
  EMAIL_QUEUE_NAME,
  EmailJobPayload,
  buildInvitationEmailJobId,
} from '../../queue/email-queue.constants';
import {
  CreateInviteDto,
  InviteCreatedDto,
  InvitePreviewDto,
  InviteStatus,
  MemberDto,
  MembersListDto,
  displayName,
  toInviteDto,
  toRole,
  toWireRole,
} from './dto/members.dto';
import {
  INVITATION_TTL_MS,
  hashInvitationToken,
  invitationUrl,
  isInvitationTokenShape,
  maskEmail,
  newInvitationToken,
} from './invitation-token';

const INVITE_RATE_LIMIT = 20;
const INVITE_RATE_WINDOW_SECONDS = 3600;

const INVITE_INCLUDE = {
  invitedBy: { select: { id: true, name: true, email: true } },
} as const;

// An invitation is open until it is accepted, revoked or expired.
function statusOf(
  invitation: Pick<Invitation, 'acceptedAt' | 'revokedAt' | 'expiresAt'>,
  now: Date,
): InviteStatus {
  if (invitation.acceptedAt) {
    return 'accepted';
  }
  if (invitation.revokedAt) {
    return 'revoked';
  }
  return invitation.expiresAt.getTime() <= now.getTime()
    ? 'expired'
    : 'pending';
}

export interface JoinedOrganization {
  organization: {
    id: string;
    name: string;
    slug: string;
    onboardingCompleted: boolean;
  };
  role: Role;
}

// Settings → Members (CLAUDE.md "Members & undangan"): invitations by email
// with a one-time link, role changes and removals. Every change is Admin
// only (guarded in the controller); an organization always keeps one Admin.
@Injectable()
export class MembersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly rateLimiter: RateLimiterService,
    private readonly realtime: RealtimePublisher,
    @InjectQueue(EMAIL_QUEUE_NAME)
    private readonly emailQueue: Queue<EmailJobPayload>,
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
  ) {}

  async list(
    organizationId: string,
    viewerId: string,
  ): Promise<MembersListDto> {
    const memberships = await this.prisma.membership.findMany({
      where: { organizationId, status: MembershipStatus.ACTIVE },
      include: {
        user: {
          select: { id: true, name: true, email: true, avatarUrl: true },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
    const viewerIsAdmin = memberships.some(
      (membership) =>
        membership.userId === viewerId && membership.role === Role.ADMIN,
    );
    const invitations = viewerIsAdmin
      ? await this.prisma.invitation.findMany({
          where: { organizationId, acceptedAt: null, revokedAt: null },
          include: INVITE_INCLUDE,
          orderBy: { createdAt: 'desc' },
        })
      : null;

    return new MembersListDto({
      members: memberships.map(
        (membership) =>
          new MemberDto({
            userId: membership.userId,
            name: displayName(membership.user),
            email: membership.user.email,
            avatarUrl: membership.user.avatarUrl,
            role: toWireRole(membership.role),
            joinedAt: membership.createdAt,
            isYou: membership.userId === viewerId,
          }),
      ),
      invites: invitations ? invitations.map(toInviteDto) : null,
    });
  }

  async invite(
    organizationId: string,
    actorUserId: string,
    dto: CreateInviteDto,
  ): Promise<InviteCreatedDto> {
    await this.assertWithinRateLimit(organizationId);
    const email = dto.email.trim().toLowerCase();
    const now = new Date();

    const member = await this.prisma.membership.findFirst({
      where: {
        organizationId,
        status: MembershipStatus.ACTIVE,
        user: { email: { equals: email, mode: 'insensitive' } },
      },
      select: { id: true },
    });
    if (member) {
      throw new ConflictException({
        field: 'email',
        message: 'already_member',
      });
    }
    const pending = await this.prisma.invitation.findFirst({
      where: {
        organizationId,
        email,
        acceptedAt: null,
        revokedAt: null,
        expiresAt: { gt: now },
      },
      select: { id: true },
    });
    if (pending) {
      throw new ConflictException({
        field: 'email',
        message: 'invite_pending',
      });
    }

    const { token, tokenHash } = newInvitationToken();
    const invitation = await this.prisma.invitation.create({
      data: {
        organizationId,
        email,
        role: toRole(dto.role),
        tokenHash,
        invitedById: actorUserId,
        expiresAt: new Date(now.getTime() + INVITATION_TTL_MS),
        emailStatus: this.mailConfigured
          ? InvitationEmailStatus.PENDING
          : InvitationEmailStatus.NOT_CONFIGURED,
      },
      include: INVITE_INCLUDE,
    });
    const sent = await this.enqueueEmail(invitation, token);

    // TODO(audit log model): persisted row once the table exists.
    this.logger.info('audit.member.invited', {
      orgId: organizationId,
      by: actorUserId,
      invitationId: invitation.id,
      role: invitation.role,
    });
    await this.announce(organizationId);
    return new InviteCreatedDto({
      invite: toInviteDto(sent),
      inviteUrl: this.urlFor(token),
    });
  }

  // A new link (the old one stops working) and a new 7 days.
  async resend(
    organizationId: string,
    actorUserId: string,
    invitationId: string,
  ): Promise<InviteCreatedDto> {
    await this.assertWithinRateLimit(organizationId);
    const existing = await this.findInvitationOrThrow(
      organizationId,
      invitationId,
    );
    this.assertOpen(existing);

    const { token, tokenHash } = newInvitationToken();
    const { count } = await this.prisma.invitation.updateMany({
      where: { id: invitationId, acceptedAt: null, revokedAt: null },
      data: {
        tokenHash,
        expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
        emailStatus: this.mailConfigured
          ? InvitationEmailStatus.PENDING
          : InvitationEmailStatus.NOT_CONFIGURED,
        emailError: null,
      },
    });
    if (count === 0) {
      // Accepted or revoked in between.
      throw new ConflictException({
        field: 'invitationId',
        message: 'invite_used',
      });
    }
    const invitation = await this.prisma.invitation.findUniqueOrThrow({
      where: { id: invitationId },
      include: INVITE_INCLUDE,
    });
    const sent = await this.enqueueEmail(invitation, token);

    this.logger.info('audit.member.invite_resent', {
      orgId: organizationId,
      by: actorUserId,
      invitationId,
    });
    await this.announce(organizationId);
    return new InviteCreatedDto({
      invite: toInviteDto(sent),
      inviteUrl: this.urlFor(token),
    });
  }

  async revoke(
    organizationId: string,
    actorUserId: string,
    invitationId: string,
  ): Promise<{ id: string }> {
    const existing = await this.findInvitationOrThrow(
      organizationId,
      invitationId,
    );
    if (existing.acceptedAt) {
      throw new ConflictException({
        field: 'invitationId',
        message: 'invite_used',
      });
    }
    if (!existing.revokedAt) {
      const { count } = await this.prisma.invitation.updateMany({
        where: { id: invitationId, acceptedAt: null, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (count > 0) {
        this.logger.info('audit.member.invite_revoked', {
          orgId: organizationId,
          by: actorUserId,
          invitationId,
        });
        await this.announce(organizationId);
      }
    }
    return { id: invitationId };
  }

  async changeRole(
    organizationId: string,
    actorUserId: string,
    userId: string,
    wireRole: CreateInviteDto['role'],
  ): Promise<MemberDto> {
    const role = toRole(wireRole);
    const { membership, previous } = await this.prisma.$transaction(
      async (tx) => {
        const current = await this.findMemberOrThrow(
          tx,
          organizationId,
          userId,
        );
        if (current.role === role) {
          return { membership: current, previous: current.role };
        }
        if (current.role === Role.ADMIN) {
          await this.assertAnotherAdmin(tx, organizationId, userId);
        }
        const updated = await tx.membership.update({
          where: { id: current.id },
          data: { role },
          include: {
            user: {
              select: { id: true, name: true, email: true, avatarUrl: true },
            },
          },
        });
        return { membership: updated, previous: current.role };
      },
    );

    if (previous !== role) {
      this.logger.info('audit.member.role_changed', {
        orgId: organizationId,
        by: actorUserId,
        userId,
        from: previous,
        to: role,
      });
      await this.announce(organizationId);
    }
    return new MemberDto({
      userId: membership.userId,
      name: displayName(membership.user),
      email: membership.user.email,
      avatarUrl: membership.user.avatarUrl,
      role: toWireRole(membership.role),
      joinedAt: membership.createdAt,
      isYou: membership.userId === actorUserId,
    });
  }

  // Also how an Admin leaves (userId = themselves) — never the last Admin.
  async remove(
    organizationId: string,
    actorUserId: string,
    userId: string,
  ): Promise<{ userId: string }> {
    const removedRole = await this.prisma.$transaction(async (tx) => {
      const current = await this.findMemberOrThrow(tx, organizationId, userId);
      if (current.role === Role.ADMIN) {
        await this.assertAnotherAdmin(tx, organizationId, userId);
      }
      await tx.membership.delete({ where: { id: current.id } });
      return current.role;
    });

    this.logger.info('audit.member.removed', {
      orgId: organizationId,
      by: actorUserId,
      userId,
      role: removedRole,
      self: userId === actorUserId,
    });
    await this.announce(organizationId);
    return { userId };
  }

  // Public: what the invite page shows before sign-in. The token is the
  // only key; the email is masked.
  async preview(token: string): Promise<InvitePreviewDto> {
    const invitation = await this.findByToken(token);
    return new InvitePreviewDto({
      organization: {
        name: invitation.organization.name,
        slug: invitation.organization.slug,
      },
      invitedBy: invitation.invitedBy
        ? { name: displayName(invitation.invitedBy) }
        : null,
      role: toWireRole(invitation.role),
      email: maskEmail(invitation.email),
      expiresAt: invitation.expiresAt,
      status: statusOf(invitation, new Date()),
    });
  }

  // Whoever holds the link joins, also when signed in with another email
  // (decision 19 Oct 2026) — the mismatch is recorded. The claim is atomic,
  // so one link makes one member; an existing member does not use it up.
  async accept(token: string, userId: string): Promise<JoinedOrganization> {
    const invitation = await this.findByToken(token);
    const now = new Date();
    const status = statusOf(invitation, now);
    if (status !== 'pending') {
      throw new GoneException({
        field: 'token',
        message: {
          accepted: 'invite_used',
          revoked: 'invite_revoked',
          expired: 'invite_expired',
        }[status],
      });
    }
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });
    if (!user) {
      throw new UnauthorizedException('Session user no longer exists.');
    }

    const organizationId = invitation.organizationId;
    const outcome = await this.prisma.$transaction(async (tx) => {
      // Checked before claiming: an existing member (typically the Admin
      // who sent it, opening the link while still signed in) must leave
      // the link valid for the person it is meant for.
      const existing = await tx.membership.findUnique({
        where: { userId_organizationId: { userId, organizationId } },
        select: { status: true },
      });
      if (existing?.status === MembershipStatus.ACTIVE) {
        return 'already_member' as const;
      }
      const claimed = await tx.invitation.updateMany({
        where: {
          id: invitation.id,
          tokenHash: invitation.tokenHash,
          acceptedAt: null,
          revokedAt: null,
          expiresAt: { gt: now },
        },
        data: { acceptedAt: now, acceptedById: userId },
      });
      if (claimed.count === 0) {
        return 'lost' as const;
      }
      await tx.membership.upsert({
        where: { userId_organizationId: { userId, organizationId } },
        create: {
          userId,
          organizationId,
          role: invitation.role,
          status: MembershipStatus.ACTIVE,
        },
        update: { role: invitation.role, status: MembershipStatus.ACTIVE },
      });
      return 'joined' as const;
    });

    if (outcome === 'lost') {
      throw new GoneException({ field: 'token', message: 'invite_used' });
    }
    if (outcome === 'already_member') {
      throw new ConflictException({
        field: 'token',
        message: 'already_member',
      });
    }
    this.logger.info('audit.member.joined', {
      orgId: organizationId,
      userId,
      invitationId: invitation.id,
      role: invitation.role,
      emailMismatch: user.email.toLowerCase() !== invitation.email,
    });
    await this.announce(organizationId);
    return { organization: invitation.organization, role: invitation.role };
  }

  private get mailConfigured(): boolean {
    return Boolean(this.configService.get<string>('mail.host'));
  }

  private urlFor(token: string): string {
    return invitationUrl(this.configService.getOrThrow<string>('feUrl'), token);
  }

  private async assertWithinRateLimit(organizationId: string): Promise<void> {
    const allowed = await this.rateLimiter.tryConsume(
      `ratelimit:invite:org:${organizationId}`,
      INVITE_RATE_LIMIT,
      INVITE_RATE_WINDOW_SECONDS,
    );
    if (!allowed) {
      throw new HttpException(
        { field: 'email', message: 'invite_rate_limited' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  // The email goes out from the worker. The invitation stands even when the
  // queue cannot take the job: marked failed, the Admin still has the link.
  private async enqueueEmail<T extends Invitation>(
    invitation: T,
    token: string,
  ): Promise<T> {
    if (!this.mailConfigured) {
      return invitation;
    }
    try {
      await this.emailQueue.add(
        'invitation',
        { kind: 'invitation', invitationId: invitation.id, token },
        {
          ...EMAIL_JOB_OPTIONS,
          jobId: buildInvitationEmailJobId(invitation.id, Date.now()),
        },
      );
      return invitation;
    } catch (error) {
      this.logger.error('member.invite_enqueue_failed', {
        invitationId: invitation.id,
        error: error instanceof Error ? error.message : String(error),
      });
      await this.prisma.invitation.update({
        where: { id: invitation.id },
        data: {
          emailStatus: InvitationEmailStatus.FAILED,
          emailError: 'queue_unavailable',
        },
      });
      return {
        ...invitation,
        emailStatus: InvitationEmailStatus.FAILED,
        emailError: 'queue_unavailable',
      };
    }
  }

  private async findInvitationOrThrow(
    organizationId: string,
    invitationId: string,
  ) {
    const invitation = await this.prisma.invitation.findUnique({
      where: { id: invitationId },
    });
    if (!invitation || invitation.organizationId !== organizationId) {
      throw new NotFoundException({
        field: 'invitationId',
        message: 'invite_not_found',
      });
    }
    return invitation;
  }

  private assertOpen(invitation: Invitation): void {
    if (invitation.acceptedAt) {
      throw new ConflictException({
        field: 'invitationId',
        message: 'invite_used',
      });
    }
    if (invitation.revokedAt) {
      throw new ConflictException({
        field: 'invitationId',
        message: 'invite_revoked',
      });
    }
  }

  private async findByToken(token: string) {
    const invitation = isInvitationTokenShape(token)
      ? await this.prisma.invitation.findUnique({
          where: { tokenHash: hashInvitationToken(token) },
          include: {
            organization: {
              select: {
                id: true,
                name: true,
                slug: true,
                onboardingCompleted: true,
              },
            },
            invitedBy: { select: { name: true, email: true } },
          },
        })
      : null;
    if (!invitation) {
      throw new NotFoundException({
        field: 'token',
        message: 'invite_not_found',
      });
    }
    return invitation;
  }

  private async findMemberOrThrow(
    tx: Prisma.TransactionClient,
    organizationId: string,
    userId: string,
  ) {
    const membership = await tx.membership.findUnique({
      where: { userId_organizationId: { userId, organizationId } },
      include: {
        user: {
          select: { id: true, name: true, email: true, avatarUrl: true },
        },
      },
    });
    if (!membership || membership.status !== MembershipStatus.ACTIVE) {
      throw new NotFoundException({
        field: 'userId',
        message: 'member_not_found',
      });
    }
    return membership;
  }

  // Locks the org's Admin rows first: two Admins demoting each other at the
  // same moment would otherwise both see "another Admin" and leave none.
  private async assertAnotherAdmin(
    tx: Prisma.TransactionClient,
    organizationId: string,
    userId: string,
  ): Promise<void> {
    const admins = await tx.$queryRaw<Array<{ userId: string }>>`
      SELECT "userId" FROM "memberships"
      WHERE "organizationId" = ${organizationId}
        AND "role" = 'ADMIN' AND "status" = 'ACTIVE'
      FOR UPDATE`;
    if (!admins.some((admin) => admin.userId !== userId)) {
      throw new UnprocessableEntityException({
        field: 'userId',
        message: 'last_admin',
      });
    }
  }

  private announce(organizationId: string): Promise<void> {
    return this.realtime.publish({
      type: 'settings.updated',
      orgId: organizationId,
      area: 'members',
    });
  }
}
