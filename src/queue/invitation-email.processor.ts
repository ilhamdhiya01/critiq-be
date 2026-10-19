import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job } from 'bullmq';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import { Logger } from 'winston';
import { MailSendError, MailService } from '../common/mail/mail.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { RealtimePublisher } from '../common/realtime/realtime.publisher';
import { InvitationEmailStatus } from '../generated/prisma/enums';
import { renderInvitationEmail } from '../modules/members/invitation-email';
import {
  hashInvitationToken,
  invitationUrl,
} from '../modules/members/invitation-token';
import { EMAIL_QUEUE_NAME, EmailJobPayload } from './email-queue.constants';

// Sends invitation emails (CLAUDE.md "Members & undangan"). Runs only in the
// worker. Neither the token nor the message is ever logged.
@Processor(EMAIL_QUEUE_NAME)
export class InvitationEmailProcessor extends WorkerHost {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mailService: MailService,
    private readonly configService: ConfigService,
    private readonly realtime: RealtimePublisher,
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
  ) {
    super();
  }

  async process(job: Job<EmailJobPayload>): Promise<void> {
    const { invitationId, token } = job.data;
    const invitation = await this.prisma.invitation.findUnique({
      where: { id: invitationId },
      include: {
        organization: { select: { name: true } },
        invitedBy: { select: { name: true, email: true } },
      },
    });
    // Nothing to send: gone, closed, expired, or resent since (a newer
    // token replaced this one — its link would not work).
    if (
      !invitation ||
      invitation.acceptedAt ||
      invitation.revokedAt ||
      invitation.expiresAt.getTime() <= Date.now() ||
      invitation.tokenHash !== hashInvitationToken(token)
    ) {
      this.logger.info('member.invite_email_skipped', { invitationId });
      return;
    }
    const log = {
      orgId: invitation.organizationId,
      invitationId,
      attemptsMade: job.attemptsMade,
    };

    if (!this.mailService.configured) {
      await this.settle(
        invitation.organizationId,
        invitationId,
        InvitationEmailStatus.NOT_CONFIGURED,
        null,
      );
      return;
    }

    try {
      await this.mailService.send(
        renderInvitationEmail({
          to: invitation.email,
          organizationName: invitation.organization.name,
          inviterName: invitation.invitedBy
            ? (invitation.invitedBy.name ?? invitation.invitedBy.email)
            : null,
          role: invitation.role,
          url: invitationUrl(
            this.configService.getOrThrow<string>('feUrl'),
            token,
          ),
          expiresAt: invitation.expiresAt,
        }),
      );
    } catch (error) {
      const failure =
        error instanceof MailSendError
          ? error
          : new MailSendError('unknown', true);
      const lastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      if (failure.retryable && !lastAttempt) {
        this.logger.warn('member.invite_email_retrying', {
          ...log,
          code: failure.code,
        });
        throw failure;
      }
      await this.settle(
        invitation.organizationId,
        invitationId,
        InvitationEmailStatus.FAILED,
        failure.code,
      );
      this.logger.warn('member.invite_email_failed', {
        ...log,
        code: failure.code,
      });
      return;
    }

    await this.settle(
      invitation.organizationId,
      invitationId,
      InvitationEmailStatus.SENT,
      null,
    );
    this.logger.info('member.invite_email_sent', log);
  }

  // Only while still pending: a resend may have reset the status since.
  private async settle(
    organizationId: string,
    invitationId: string,
    emailStatus: InvitationEmailStatus,
    emailError: string | null,
  ): Promise<void> {
    const { count } = await this.prisma.invitation.updateMany({
      where: { id: invitationId, emailStatus: InvitationEmailStatus.PENDING },
      data: { emailStatus, emailError },
    });
    if (count > 0) {
      await this.realtime.publish({
        type: 'settings.updated',
        orgId: organizationId,
        area: 'members',
      });
    }
  }
}
