import { SecretCandidate } from './rule.interface';
import { filterValue } from './value-filter';

function candidate(
  value: string,
  overrides: Partial<SecretCandidate> = {},
): SecretCandidate {
  return {
    ruleId: 'secret.assignment_literal',
    line: 1,
    key: 'API_SECRET',
    value,
    raw: `API_SECRET=${value}`,
    ...overrides,
  };
}

describe('filterValue', () => {
  it('keeps a value that looks like a real credential', () => {
    expect(
      filterValue(candidate('akjsbdkajsbkjabskdjbaskdjbskjdf')),
    ).toBeNull();
    expect(filterValue(candidate('S3cr3t-Passw0rd-2026'))).toBeNull();
    expect(filterValue(candidate('whsec_a1b2c3d4e5f6g7h8i9j0'))).toBeNull();
  });

  describe('env references', () => {
    it.each([
      '${GITHUB_SECRET}',
      '$GITHUB_SECRET',
      '{{ secret }}',
      '<your-token>',
      '%API_KEY%',
    ])('rejects %s by value shape', (value) => {
      expect(filterValue(candidate(value))).not.toBeNull();
    });

    it.each([
      'const t = process.env.TOKEN',
      'password = os.environ["DB_PASSWORD"]',
      'key := os.Getenv("API_KEY")',
      'secret: ${{ secrets.GITHUB_TOKEN }}',
    ])('rejects a line reading from the environment: %s', (raw) => {
      expect(filterValue(candidate('somethingLongEnough123', { raw }))).toBe(
        'env_reference',
      );
    });
  });

  describe('placeholders', () => {
    it.each([
      'changeme',
      'CHANGEME',
      'your-api-key-here',
      'example-secret-value',
      'dummy_credential_x',
      '<redacted>',
      'xxxxxxxxxxxx',
    ])('rejects %s', (value) => {
      expect(filterValue(candidate(value))).not.toBeNull();
    });
  });

  describe('patterned values', () => {
    it.each([
      'aaaaaaaaaaaaaaaa',
      '12345678901234567890',
      'abcdefghijklmnop',
      'qwertyuiopasdfgh',
    ])('rejects %s', (value) => {
      expect(filterValue(candidate(value))).toBe('patterned');
    });
  });

  describe('structurally not a secret', () => {
    it.each([
      ['550e8400-e29b-41d4-a716-446655440000', 'UUID'],
      ['1.2.3-beta.11', 'semver'],
      ['v10.2.6', 'semver with v'],
      ['2026-09-26T07:28:41', 'ISO date'],
      ['192.168.1.100', 'IPv4'],
      ['https://api.example.org/v1/things', 'plain URL'],
      ['pk_live_abcdefghijklmnopqrst', 'Stripe publishable key'],
      ['sha512-AbCdEfGhIjKlMnOpQrSt', 'subresource integrity'],
    ])('rejects %s (%s)', (value) => {
      expect(filterValue(candidate(value))).toBe('not_secret_shaped');
    });

    it('rejects a bare 40-hex git sha', () => {
      const sha = 'ec10b625ad4e3b3f6544e26f1b5aa2eab5aa7bce';
      expect(filterValue(candidate(sha, { key: 'COMMIT' }))).toBe(
        'not_secret_shaped',
      );
    });

    // The same 40 hex characters assigned to a credential-shaped key is far
    // likelier to be a real key than a commit id.
    it('keeps a 40-hex value when the key name says credential', () => {
      const value = 'ec10b625ad4e3b3f6544e26f1b5aa2eab5aa7bce';
      expect(filterValue(candidate(value, { key: 'API_SECRET' }))).toBeNull();
    });

    // A URL carrying inline credentials is the whole point of
    // secret.db_url_with_password — filtering it here would defeat that rule.
    it('keeps a URL with embedded credentials', () => {
      const value = 'postgresql://admin:hunter2pass@db.internal:5432/app';
      expect(filterValue(candidate(value, { key: 'DATABASE_URL' }))).toBeNull();
    });
  });

  describe('comments', () => {
    it('rejects a commented-out placeholder', () => {
      expect(
        filterValue(
          candidate('your-token-here', { raw: '# API_SECRET=your-token-here' }),
        ),
      ).not.toBeNull();
    });

    // A real credential in a comment is still committed to git.
    it('keeps a real-looking credential inside a comment', () => {
      expect(
        filterValue(
          candidate('akjsbdkajsbkjabskdjbaskdjbskjdf', {
            raw: '// API_SECRET=akjsbdkajsbkjabskdjbaskdjbskjdf',
          }),
        ),
      ).toBeNull();
    });
  });
});
