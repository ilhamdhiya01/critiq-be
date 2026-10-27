import type { Role } from '../../generated/prisma/enums';
import type { MailMessage } from '../../common/mail/mail.service';

const ROLE_LABEL: Record<Role, string> = {
  ADMIN: 'Admin',
  REVIEWER: 'Reviewer',
  VIEWER: 'Viewer',
};

// What the role lets the recipient do — context for an invitation they
// may not have expected.
const ROLE_DESCRIPTION: Record<Role, string> = {
  ADMIN: 'Manage repositories, integrations, members and settings.',
  REVIEWER:
    'Review pull requests, approve or request changes, and comment on code.',
  VIEWER: 'Read-only access to pull requests, findings and activity.',
};

const ABOUT_CRITIQ =
  'Critiq reviews pull request diffs and flags critical issues — the approve and merge decision stays with your team.';
const IGNORE_NOTE = "If you weren't expecting this, you can ignore this email.";

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
  const roleDescription = ROLE_DESCRIPTION[input.role];
  const who = input.inviterName ?? 'An admin';
  const expires = input.expiresAt.toUTCString();
  // A header: no line breaks from the user-written name.
  const subject = `You're invited to ${input.organizationName.replace(/[\r\n]+/g, ' ')} on Critiq`;
  const text = [
    `${who} invited you to join ${input.organizationName} on Critiq as ${role}.`,
    '',
    `${role}: ${roleDescription}`,
    '',
    `Accept the invitation: ${input.url}`,
    '',
    `This link works once and expires on ${expires}.`,
    '',
    ABOUT_CRITIQ,
    IGNORE_NOTE,
  ].join('\n');

  const org = escapeHtml(input.organizationName);
  const inviter = escapeHtml(who);
  const url = escapeHtml(input.url);
  // Email clients ignore stylesheets, flex and grid: layout is tables with
  // inline styles, and no remote images (often blocked by default).
  const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(subject)}</title>
  </head>
  <body style="margin: 0; padding: 0; background: #f4f4f5;">
    <div style="display: none; max-height: 0; overflow: hidden; opacity: 0;">${inviter} invited you to ${org} on Critiq.</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background: #f4f4f5;">
      <tr>
        <td align="center" style="padding: 32px 16px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width: 560px; font-family: -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #18181b;">
            <tr>
              <td style="padding: 0 4px 16px; font-size: 20px; font-weight: 700; color: #4f46e5; letter-spacing: -0.2px;">Critiq</td>
            </tr>
            <tr>
              <td style="background: #ffffff; border: 1px solid #e4e4e7; border-radius: 12px; padding: 32px;">
                <h1 style="margin: 0 0 16px; font-size: 22px; line-height: 1.3; font-weight: 600; color: #18181b;">Join ${org} on Critiq</h1>
                <p style="margin: 0 0 20px; font-size: 15px; line-height: 1.6; color: #3f3f46;">${inviter} invited you to join <strong>${org}</strong> as <strong>${role}</strong>.</p>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin: 0 0 24px;">
                  <tr>
                    <td style="background: #eef2ff; border-radius: 8px; padding: 12px 16px; font-size: 14px; line-height: 1.5; color: #3730a3;">
                      <strong>${role}</strong> &middot; ${roleDescription}
                    </td>
                  </tr>
                </table>
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin: 0 0 24px;">
                  <tr>
                    <td align="center" bgcolor="#4f46e5" style="border-radius: 8px;">
                      <a href="${url}" style="display: inline-block; padding: 12px 24px; font-size: 15px; font-weight: 600; color: #ffffff; text-decoration: none; border-radius: 8px;">Accept invitation</a>
                    </td>
                  </tr>
                </table>
                <p style="margin: 0 0 4px; font-size: 13px; line-height: 1.5; color: #71717a;">Button not working? Paste this link into your browser:</p>
                <p style="margin: 0 0 20px; font-size: 13px; line-height: 1.5; word-break: break-all;"><a href="${url}" style="color: #4f46e5;">${url}</a></p>
                <p style="margin: 0; padding-top: 16px; border-top: 1px solid #f4f4f5; font-size: 13px; line-height: 1.5; color: #71717a;">This link works once and expires on ${escapeHtml(expires)}.</p>
              </td>
            </tr>
            <tr>
              <td style="padding: 16px 4px 0; font-size: 12px; line-height: 1.5; color: #a1a1aa;">${escapeHtml(ABOUT_CRITIQ)}<br />${escapeHtml(IGNORE_NOTE)}</td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
  return { to: input.to, subject, text, html };
}
