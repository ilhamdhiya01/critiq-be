import {
  hashInvitationToken,
  invitationUrl,
  isInvitationTokenShape,
  maskEmail,
  newInvitationToken,
} from './invitation-token';
import { renderInvitationEmail } from './invitation-email';

describe('invitation token', () => {
  it('stores only a hash of a fresh, link-safe token', () => {
    const { token, tokenHash } = newInvitationToken();
    expect(isInvitationTokenShape(token)).toBe(true);
    expect(tokenHash).toBe(hashInvitationToken(token));
    expect(tokenHash).not.toContain(token);
    expect(newInvitationToken().token).not.toBe(token);
  });

  it.each(['', 'short', 'a'.repeat(43) + '!', '../../etc/passwd'])(
    'rejects %p as a token',
    (value) => {
      expect(isInvitationTokenShape(value)).toBe(false);
    },
  );

  it('builds the FE link', () => {
    expect(invitationUrl('https://critiq-dev.web.id/', 'tok')).toBe(
      'https://critiq-dev.web.id/invite/tok',
    );
  });

  it.each([
    ['kantor@perusahaan.com', 'ka***@perusahaan.com'],
    ['ab@x.io', 'a***@x.io'],
    ['a@x.io', 'a***@x.io'],
    ['nope', '***'],
  ])('masks %s', (email, masked) => {
    expect(maskEmail(email)).toBe(masked);
  });
});

describe('renderInvitationEmail', () => {
  const email = (organizationName: string, inviterName: string | null) =>
    renderInvitationEmail({
      to: 'kantor@perusahaan.com',
      organizationName,
      inviterName,
      role: 'REVIEWER',
      url: 'https://critiq-dev.web.id/invite/tok',
      expiresAt: new Date('2026-10-26T00:00:00Z'),
    });

  it('names the organization, inviter, role and link', () => {
    const message = email('Acme', 'Alex Winter');
    expect(message.to).toBe('kantor@perusahaan.com');
    expect(message.subject).toBe("You're invited to Acme on Critiq");
    expect(message.text).toContain('Alex Winter invited you to join Acme');
    expect(message.text).toContain('as Reviewer');
    expect(message.html).toContain(
      'href="https://critiq-dev.web.id/invite/tok"',
    );
  });

  // Names are user-written: no markup or header injection through them.
  it('escapes names in HTML and keeps the subject on one line', () => {
    const message = email('<a href="https://evil">Acme</a>\r\nBcc: x', null);
    expect(message.html).not.toContain('<a href="https://evil">');
    expect(message.html).toContain('&lt;a href=&quot;https://evil&quot;&gt;');
    expect(message.subject).not.toMatch(/[\r\n]/);
    expect(message.text).toContain('An admin invited you');
  });

  it('explains what the role can do, in both parts', () => {
    const reviewer = email('Acme', 'Alex Winter');
    expect(reviewer.html).toContain('Review pull requests');
    expect(reviewer.text).toContain('Reviewer: Review pull requests');

    const viewer = renderInvitationEmail({
      to: 'kantor@perusahaan.com',
      organizationName: 'Acme',
      inviterName: null,
      role: 'VIEWER',
      url: 'https://critiq-dev.web.id/invite/tok',
      expiresAt: new Date('2026-10-26T00:00:00Z'),
    });
    expect(viewer.html).toContain('Read-only access');
    expect(viewer.text).toContain('Viewer: Read-only access');
  });

  // The button and a plain fallback link for clients that break buttons.
  it('links the invitation from the button and as fallback text', () => {
    const { html } = email('Acme', 'Alex Winter');
    expect(
      html.match(/href="https:\/\/critiq-dev\.web\.id\/invite\/tok"/g),
    ).toHaveLength(2);
    expect(html).toContain('>https://critiq-dev.web.id/invite/tok</a>');
  });

  it('escapes names in the preview text and heading too', () => {
    const { html } = email('<b>Acme</b>', '<i>Alex</i>');
    expect(html).not.toMatch(/<b>|<i>/);
    expect(html).toContain('Join &lt;b&gt;Acme&lt;/b&gt; on Critiq');
    expect(html).toContain(
      '&lt;i&gt;Alex&lt;/i&gt; invited you to &lt;b&gt;Acme&lt;/b&gt; on Critiq.',
    );
  });
});
