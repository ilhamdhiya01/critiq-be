// The `email` queue: outgoing email, sent by the worker so a slow or
// unreachable SMTP server never holds up a request.
export const EMAIL_QUEUE_NAME = 'email';

// The raw invitation token travels here because only its hash is stored —
// the worker needs it to write the link. Jobs are removed when they finish
// or fail, so it does not linger in Redis.
export interface InvitationEmailJobPayload {
  kind: 'invitation';
  invitationId: string;
  token: string;
}

export type EmailJobPayload = InvitationEmailJobPayload;

// No ':' (BullMQ 6); a resend must not collide with the earlier job.
export function buildInvitationEmailJobId(
  invitationId: string,
  requestedAt: number,
): string {
  return `email-invitation-${invitationId}-${requestedAt}`;
}

export const EMAIL_JOB_OPTIONS = {
  attempts: 4, // 1 + 3 retries
  backoff: { type: 'exponential', delay: 30_000 },
  removeOnComplete: true,
  removeOnFail: true,
} as const;
