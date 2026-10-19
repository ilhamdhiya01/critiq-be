import type { Role } from '../../generated/prisma/enums';
import type { MailMessage } from '../../common/mail/mail.service';

const ROLE_LABEL: Record<Role, string> = {
  ADMIN: 'Admin',
  REVIEWER: 'Reviewer',
  VIEWER: 'Viewer',
};

// Organization and inviter names are user-written: escaped for the HTML
// part, so they cannot inject markup or links into the email.
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderInvitationEmail(input: {
  to: string;
  organizationName: string;
  inviterName: string | null;
  role: Role;
  url: string;
  expiresAt: Date;
}): MailMessage {
  const role = ROLE_LABEL[input.role];
  const who = input.inviterName ?? 'An admin';
  const expires = input.expiresAt.toUTCString();
  // A header: no line breaks from the user-written name.
  const subject = `You're invited to ${input.organizationName.replace(/[\r\n]+/g, ' ')} on Critiq`;
  const text = [
    `${who} invited you to join ${input.organizationName} on Critiq as ${role}.`,
    '',
    `Accept the invitation: ${input.url}`,
    '',
    `This link works once and expires on ${expires}.`,
    "If you weren't expecting this, you can ignore this email.",
  ].join('\n');
  const html = `<!doctype html>
<html>
  <body style="font-family: -apple-system, Segoe UI, sans-serif; color: #111; line-height: 1.5;">
    <p>${escapeHtml(who)} invited you to join <strong>${escapeHtml(input.organizationName)}</strong> on Critiq as <strong>${role}</strong>.</p>
    <p>
      <a href="${escapeHtml(input.url)}" style="display: inline-block; padding: 10px 18px; background: #4f46e5; color: #fff; text-decoration: none; border-radius: 6px;">Accept invitation</a>
    </p>
    <p style="color: #555; font-size: 13px;">This link works once and expires on ${escapeHtml(expires)}.<br />If you weren't expecting this, you can ignore this email.</p>
  </body>
</html>`;
  return { to: input.to, subject, text, html };
}
