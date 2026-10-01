import {
  BadGatewayException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { classifyProviderError, providerErrorDetail } from './scan-errors';

jest.mock('bullmq', () => ({
  UnrecoverableError: class UnrecoverableError extends Error {},
}));

const httpError = (body: Record<string, unknown>) =>
  new UnprocessableEntityException(body);

describe('classifyProviderError', () => {
  it.each([
    ['token_invalid', 'credential'],
    ['installation_invalid', 'credential'],
    ['instance_unreachable', 'retryable'],
    ['github_unreachable', 'retryable'],
    // Sent again, the same request is refused again.
    ['provider_bad_request', 'rejected'],
    ['something_else', 'unknown'],
  ])('%s → %s', (message, kind) => {
    expect(classifyProviderError(httpError({ message }))).toBe(kind);
  });

  it('treats a timeout (502) as retryable and a plain Error as unknown', () => {
    expect(
      classifyProviderError(
        new BadGatewayException({ message: 'provider_unreachable' }),
      ),
    ).toBe('retryable');
    expect(classifyProviderError(new Error('boom'))).toBe('unknown');
  });
});

describe('providerErrorDetail', () => {
  it('returns the provider reason when the error carries one', () => {
    expect(
      providerErrorDetail(
        httpError({
          message: 'provider_bad_request',
          detail: '"Provide at least 2 refs"',
        }),
      ),
    ).toBe('"Provide at least 2 refs"');
    expect(providerErrorDetail(httpError({ message: 'x' }))).toBeNull();
    expect(providerErrorDetail(new Error('boom'))).toBeNull();
  });
});
