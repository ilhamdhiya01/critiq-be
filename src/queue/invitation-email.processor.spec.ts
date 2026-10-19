import { ConfigService } from '@nestjs/config';
import type { Job } from 'bullmq';
import { Logger } from 'winston';
import { MailSendError, MailService } from '../common/mail/mail.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { RealtimePublisher } from '../common/realtime/realtime.publisher';
import { InvitationEmailStatus, Role } from '../generated/prisma/enums';
import {
  hashInvitationToken,
  newInvitationToken,
} from '../modules/members/invitation-token';
import type { EmailJobPayload } from './email-queue.constants';
import { InvitationEmailProcessor } from './invitation-email.processor';

jest.mock('@nestjs/bullmq', () => ({
  Processor: () => () => undefined,
  WorkerHost: class {},
}));
jest.mock('@nestjs/config', () => ({ ConfigService: class {} }));
jest.mock('../common/prisma/prisma.service', () => ({
  PrismaService: class {},
}));
jest.mock('../common/realtime/realtime.publisher', () => ({
  RealtimePublisher: class {},
}));
jest.mock('../common/mail/mail.service', () => {
  class MailSendError extends Error {
    constructor(
      readonly code: string,
      readonly retryable: boolean,
    ) {
      super(code);
    }
  }
  return { MailSendError, MailService: class {} };
});

const { token } = newInvitationToken();

function invitationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'inv_1',
    organizationId: 'org_1',
    email: 'kantor@perusahaan.com',
    role: Role.VIEWER,
    tokenHash: hashInvitationToken(token),
    expiresAt: new Date(Date.now() + 86_400_000),
    acceptedAt: null,
    revokedAt: null,
    organization: { name: 'Acme' },
    invitedBy: { name: 'Alex Winter', email: 'alex@x.io' },
    ...overrides,
  };
}

function setup(row: unknown = invitationRow(), configured = true) {
  const prisma = {
    invitation: {
      findUnique: jest.fn().mockResolvedValue(row),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const mail = { configured, send: jest.fn().mockResolvedValue(undefined) };
  const realtime = { publish: jest.fn() };
  const processor = new InvitationEmailProcessor(
    prisma as unknown as PrismaService,
    mail as unknown as MailService,
    {
      getOrThrow: () => 'https://critiq-dev.web.id',
    } as unknown as ConfigService,
    realtime as unknown as RealtimePublisher,
    { info: jest.fn(), warn: jest.fn() } as unknown as Logger,
  );
  return { processor, prisma, mail, realtime };
}

const job = (attemptsMade = 0, jobToken = token) =>
  ({
    data: { kind: 'invitation', invitationId: 'inv_1', token: jobToken },
    attemptsMade,
    opts: { attempts: 4 },
  }) as unknown as Job<EmailJobPayload>;

const statusWritten = (prisma: ReturnType<typeof setup>['prisma']) =>
  (
    prisma.invitation.updateMany.mock.calls.at(-1) as [
      { data: Record<string, unknown> },
    ]
  )[0].data;

describe('InvitationEmailProcessor', () => {
  it('emails the link and marks it sent', async () => {
    const { processor, prisma, mail, realtime } = setup();
    await processor.process(job());
    expect(mail.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'kantor@perusahaan.com',
        text: expect.stringContaining(
          `https://critiq-dev.web.id/invite/${token}`,
        ) as string,
      }),
    );
    expect(statusWritten(prisma)).toEqual({
      emailStatus: InvitationEmailStatus.SENT,
      emailError: null,
    });
    expect(realtime.publish).toHaveBeenCalledWith({
      type: 'settings.updated',
      orgId: 'org_1',
      area: 'members',
    });
  });

  // Resent since: this job's link would not work any more.
  it.each([
    ['a replaced token', invitationRow(), 'old-token'],
    [
      'an accepted invitation',
      invitationRow({ acceptedAt: new Date() }),
      token,
    ],
    ['a revoked invitation', invitationRow({ revokedAt: new Date() }), token],
    ['an expired invitation', invitationRow({ expiresAt: new Date(0) }), token],
  ])('sends nothing for %s', async (_case, row, jobToken) => {
    const { processor, mail, prisma } = setup(row);
    await processor.process(job(0, jobToken));
    expect(mail.send).not.toHaveBeenCalled();
    expect(prisma.invitation.updateMany).not.toHaveBeenCalled();
  });

  it('fails at once when the SMTP server refuses the login', async () => {
    const { processor, prisma, mail } = setup();
    mail.send.mockRejectedValue(new MailSendError('smtp_535', false));
    await expect(processor.process(job(0))).resolves.toBeUndefined();
    expect(statusWritten(prisma)).toEqual({
      emailStatus: InvitationEmailStatus.FAILED,
      emailError: 'smtp_535',
    });
  });

  it('leaves a transient failure to BullMQ, then fails on the last attempt', async () => {
    const { processor, prisma, mail } = setup();
    const timeout = new MailSendError('etimedout', true);
    mail.send.mockRejectedValue(timeout);
    await expect(processor.process(job(0))).rejects.toBe(timeout);
    expect(prisma.invitation.updateMany).not.toHaveBeenCalled();

    await processor.process(job(3));
    expect(statusWritten(prisma)).toMatchObject({
      emailStatus: InvitationEmailStatus.FAILED,
    });
  });

  it('records a worker without SMTP as not configured', async () => {
    const { processor, prisma, mail } = setup(invitationRow(), false);
    await processor.process(job());
    expect(mail.send).not.toHaveBeenCalled();
    expect(statusWritten(prisma)).toEqual({
      emailStatus: InvitationEmailStatus.NOT_CONFIGURED,
      emailError: null,
    });
  });
});
