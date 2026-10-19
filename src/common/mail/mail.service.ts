import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport, type Transporter } from 'nodemailer';

export interface MailConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
}

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

// Why a send failed, and whether trying again can help.
export class MailSendError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(`mail_${code}`);
  }
}

// Rejected for good: bad credentials, a recipient or sender the server
// refuses, an unusable configuration. Everything else (connection, timeout,
// 4xx) may pass on a later attempt.
const FINAL_CODES = new Set(['EAUTH', 'ENOAUTH', 'EENVELOPE', 'ECONFIG']);

export function classifyMailError(error: unknown): MailSendError {
  const detail = error as { code?: unknown; responseCode?: unknown };
  const code = typeof detail.code === 'string' ? detail.code : 'UNKNOWN';
  const responseCode =
    typeof detail.responseCode === 'number' ? detail.responseCode : null;
  const permanent =
    FINAL_CODES.has(code) || (responseCode !== null && responseCode >= 500);
  return new MailSendError(
    (responseCode !== null ? `smtp_${responseCode}` : code).toLowerCase(),
    !permanent,
  );
}

// Outgoing email over SMTP (invitations today). Configured from the
// environment only; without SMTP_HOST nothing is ever sent. Credentials and
// message bodies never reach the logs.
@Injectable()
export class MailService {
  private readonly transporter: Transporter | null;
  private readonly from: string;

  constructor(configService: ConfigService) {
    const mail = configService.getOrThrow<MailConfig>('mail');
    this.from = mail.from;
    this.transporter = mail.host
      ? createTransport({
          host: mail.host,
          port: mail.port,
          secure: mail.secure,
          auth: mail.user ? { user: mail.user, pass: mail.pass } : undefined,
          connectionTimeout: 15_000,
          greetingTimeout: 10_000,
          socketTimeout: 30_000,
        })
      : null;
  }

  get configured(): boolean {
    return this.transporter !== null;
  }

  async send(message: MailMessage): Promise<void> {
    if (!this.transporter) {
      throw new MailSendError('not_configured', false);
    }
    try {
      await this.transporter.sendMail({ from: this.from, ...message });
    } catch (error) {
      throw classifyMailError(error);
    }
  }
}
