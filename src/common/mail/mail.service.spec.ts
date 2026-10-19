import { ConfigService } from '@nestjs/config';
import { createTransport } from 'nodemailer';
import { MailSendError, MailService, classifyMailError } from './mail.service';

jest.mock('@nestjs/config', () => ({ ConfigService: class {} }));
jest.mock('nodemailer', () => ({ createTransport: jest.fn() }));

const createTransportMock = createTransport as unknown as jest.Mock;

function setup(host: string) {
  const sendMail = jest.fn().mockResolvedValue({ messageId: 'm1' });
  createTransportMock.mockReset().mockReturnValue({ sendMail });
  const config = {
    getOrThrow: () => ({
      host,
      port: 465,
      secure: true,
      user: 'smtp-user',
      pass: 'smtp-pass',
      from: 'Critiq <no-reply@critiq-dev.web.id>',
    }),
  };
  const service = new MailService(config as unknown as ConfigService);
  return { service, sendMail };
}

const message = {
  to: 'a@x.io',
  subject: 's',
  text: 't',
  html: '<p>t</p>',
};

describe('MailService', () => {
  it('sends from the configured sender over SMTPS', async () => {
    const { service, sendMail } = setup('smtp.sumopod.com');
    expect(service.configured).toBe(true);
    expect(createTransportMock).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'smtp.sumopod.com',
        port: 465,
        secure: true,
        auth: { user: 'smtp-user', pass: 'smtp-pass' },
      }),
    );
    await service.send(message);
    expect(sendMail).toHaveBeenCalledWith({
      from: 'Critiq <no-reply@critiq-dev.web.id>',
      ...message,
    });
  });

  it('sends nothing without a host', async () => {
    const { service } = setup('');
    expect(service.configured).toBe(false);
    expect(createTransportMock).not.toHaveBeenCalled();
    await expect(service.send(message)).rejects.toMatchObject({
      code: 'not_configured',
      retryable: false,
    });
  });

  it('turns a transport error into a classified one', async () => {
    const { service, sendMail } = setup('smtp.sumopod.com');
    sendMail.mockRejectedValue(
      Object.assign(new Error('Invalid login'), {
        code: 'EAUTH',
        responseCode: 535,
      }),
    );
    await expect(service.send(message)).rejects.toBeInstanceOf(MailSendError);
  });
});

describe('classifyMailError', () => {
  it.each([
    [{ code: 'EAUTH', responseCode: 535 }, 'smtp_535', false],
    [{ code: 'EENVELOPE', responseCode: 550 }, 'smtp_550', false],
    [{ code: 'EENVELOPE' }, 'eenvelope', false],
    [{ code: 'ETIMEDOUT' }, 'etimedout', true],
    [{ code: 'ECONNECTION' }, 'econnection', true],
    [{ code: 'EMESSAGE', responseCode: 451 }, 'smtp_451', true],
    [{}, 'unknown', true],
  ])('%p → %s (retry: %s)', (error, code, retryable) => {
    expect(classifyMailError(error)).toMatchObject({ code, retryable });
  });
});
