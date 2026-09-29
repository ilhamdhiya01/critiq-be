import { AiError } from './ai-error';
import { assertSafeBaseUrl, isPrivateAddress } from './base-url-guard';

// DNS is mocked: `host → addresses`.
function resolver(table: Record<string, string[]>) {
  return (hostname: string) => {
    const addresses = table[hostname];
    if (!addresses) {
      return Promise.reject(new Error('ENOTFOUND'));
    }
    return Promise.resolve(
      addresses.map((address) => ({ address, family: 4 })),
    );
  };
}

const PUBLIC = resolver({
  'api.example-gateway.com': ['203.0.113.10'],
  'vllm.internal': ['10.0.0.5'],
  'rebind.example.com': ['203.0.113.10', '169.254.169.254'],
});

async function rejection(
  url: string,
  allowlist: string[] = [],
): Promise<string | null> {
  try {
    await assertSafeBaseUrl(url, allowlist, PUBLIC);
    return null;
  } catch (error) {
    expect(error).toBeInstanceOf(AiError);
    return (error as AiError).code;
  }
}

describe('assertSafeBaseUrl', () => {
  it('accepts public https', async () => {
    expect(await rejection('https://api.example-gateway.com/v1')).toBeNull();
  });

  // Acceptance 5.
  it('rejects plain http unless the host is allowlisted', async () => {
    expect(await rejection('http://10.0.0.5:8000/v1')).toBe(
      'insecure_base_url',
    );
    expect(await rejection('http://10.0.0.5:8000/v1', ['10.0.0.5'])).toBeNull();
  });

  it('rejects credentials in the URL', async () => {
    expect(
      await rejection('https://user:pass@api.example-gateway.com/v1'),
    ).toBe('insecure_base_url');
  });

  // Beyond the spec: https to an internal address is SSRF too.
  it.each([
    'https://169.254.169.254/latest',
    'https://127.0.0.1/v1',
    'https://10.1.2.3/v1',
    'https://[::1]/v1',
    'https://vllm.internal/v1',
    'https://rebind.example.com/v1',
  ])('rejects %s', async (url) => {
    expect(await rejection(url)).toBe('insecure_base_url');
  });

  it('lets an allowlisted internal host through', async () => {
    expect(
      await rejection('https://vllm.internal/v1', ['vllm.internal']),
    ).toBeNull();
  });

  it('rejects an unresolvable host and a non-http scheme', async () => {
    expect(await rejection('https://nowhere.invalid/v1')).toBe(
      'insecure_base_url',
    );
    expect(await rejection('file:///etc/passwd')).toBe('insecure_base_url');
  });
});

describe('isPrivateAddress', () => {
  it.each([
    ['10.0.0.1', true],
    ['172.20.1.1', true],
    ['192.168.1.1', true],
    ['100.64.0.1', true],
    ['::ffff:10.0.0.1', true],
    ['fd00::1', true],
    ['8.8.8.8', false],
    ['2606:4700::1111', false],
  ])('%s → %s', (address, expected) => {
    expect(isPrivateAddress(address)).toBe(expected);
  });
});
