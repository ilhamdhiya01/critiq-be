import { AiError, sanitizeProviderMessage, toAiError } from './ai-error';

function sdkError(props: Record<string, unknown>, message = 'boom'): Error {
  return Object.assign(new Error(message), props);
}

describe('toAiError', () => {
  it.each([
    [{ status: 401 }, 'auth_failed', false],
    [{ status: 403 }, 'auth_failed', false],
    [{ status: 429 }, 'rate_limited', true],
    [{ status: 408 }, 'timeout', true],
    [{ name: 'APIConnectionTimeoutError' }, 'timeout', true],
    [{ name: 'AbortError' }, 'timeout', true],
    [{ status: 500 }, 'provider_unreachable', true],
    [{ status: 529 }, 'provider_unreachable', true],
    [{ code: 'ECONNREFUSED' }, 'provider_unreachable', true],
    [{ cause: { code: 'ENOTFOUND' } }, 'provider_unreachable', true],
    [{ name: 'APIConnectionError' }, 'provider_unreachable', true],
    [{ status: 400 }, 'bad_request', false],
    [{ status: 404 }, 'bad_request', false],
  ])('%j → %s (retryable %s)', (props, code, retryable) => {
    const error = toAiError(sdkError(props));
    expect(error.code).toBe(code);
    expect(error.retryable).toBe(retryable);
  });

  it('passes an AiError through', () => {
    const original = new AiError('invalid_response');
    expect(toAiError(original)).toBe(original);
    expect(original.retryable).toBe(true);
  });

  it('rethrows errors that are not provider failures', () => {
    const bug = new TypeError('cannot read x of undefined');
    expect(() => toAiError(bug)).toThrow(bug);
  });

  // Acceptance 14.
  it('sanitizes a provider message that echoes the key', () => {
    const error = toAiError(
      sdkError(
        { status: 401 },
        'Incorrect API key provided: sk-proj-abcdef1234567890. Header: Bearer sk-live-xyz',
      ),
    );
    expect(error.providerMessage).not.toMatch(/abcdef1234567890|sk-live-xyz/);
    expect(error.providerMessage).toContain('sk-***');
    expect(error.providerMessage).toContain('Bearer ***');
  });
});

describe('sanitizeProviderMessage', () => {
  it('caps the message at 300 characters', () => {
    expect(sanitizeProviderMessage('x'.repeat(1000))).toHaveLength(300);
  });
});
