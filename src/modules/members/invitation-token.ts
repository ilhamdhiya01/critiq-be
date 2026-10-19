import { createHash, randomBytes } from 'crypto';

export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// 256 random bits: the link itself is the credential, so it must not be
// guessable. Only its hash is stored.
export function newInvitationToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: hashInvitationToken(token) };
}

export function hashInvitationToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// A token as the link carries it; anything else cannot be one.
export function isInvitationTokenShape(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value);
}

export function invitationUrl(feUrl: string, token: string): string {
  return `${feUrl.replace(/\/+$/, '')}/invite/${token}`;
}

// For the public preview: enough to recognize the address, not to harvest
// it. "kantor@perusahaan.com" → "ka***@perusahaan.com".
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) {
    return '***';
  }
  const keep = at <= 2 ? 1 : 2;
  return `${email.slice(0, keep)}***${email.slice(at)}`;
}
