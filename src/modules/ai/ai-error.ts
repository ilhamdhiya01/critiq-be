// One error shape for every adapter, so callers (Settings test now, the scan
// worker in step 2) decide retry and user-facing messages without knowing
// which SDK threw.

export type AiErrorCode =
  | 'auth_failed'
  | 'rate_limited'
  | 'timeout'
  | 'provider_unreachable'
  | 'invalid_response'
  // The provider stopped at max_tokens before the tool call was complete.
  // Not retryable: the same request stops at the same limit again.
  | 'output_truncated'
  | 'bad_request'
  // Configuration problems, raised before any call is made.
  | 'insecure_base_url'
  | 'not_configured'
  | 'api_key_required'
  | 'base_url_required';

const RETRYABLE: ReadonlySet<AiErrorCode> = new Set<AiErrorCode>([
  'rate_limited',
  'timeout',
  'provider_unreachable',
  // Retried once by the caller, not by the transport.
  'invalid_response',
]);

const MAX_PROVIDER_MESSAGE = 300;

// Provider error bodies sometimes echo the credential back ("Incorrect API
// key provided: sk-…"). Everything that leaves an adapter — logs, the test
// endpoint's response — goes through this first.
export function sanitizeProviderMessage(message: string): string {
  return message
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
    .replace(/Bearer\s+[^\s"',]+/gi, 'Bearer ***')
    .slice(0, MAX_PROVIDER_MESSAGE);
}

export class AiError extends Error {
  readonly retryable: boolean;
  // Sanitized, at most 300 characters — safe to log and to show an Admin.
  readonly providerMessage: string | null;
  // HTTP status the provider answered with, when there was one.
  readonly status: number | undefined;
  // For invalid_response only: what the model actually returned, kept for
  // debugging (stored encrypted, never logged). Never contains the key.
  readonly raw: unknown;

  constructor(
    readonly code: AiErrorCode,
    options: {
      providerMessage?: string | null;
      status?: number;
      raw?: unknown;
    } = {},
  ) {
    super(code);
    this.name = 'AiError';
    this.retryable = RETRYABLE.has(code);
    this.providerMessage =
      options.providerMessage == null
        ? null
        : sanitizeProviderMessage(options.providerMessage);
    this.status = options.status;
    this.raw = options.raw;
  }
}

const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'ECONNRESET',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ETIMEDOUT',
]);

interface ErrorLike {
  name?: unknown;
  message?: unknown;
  status?: unknown;
  code?: unknown;
  cause?: unknown;
}

function networkCode(error: ErrorLike): string | null {
  for (const candidate of [error, error.cause as ErrorLike | undefined]) {
    const code = candidate?.code;
    if (typeof code === 'string' && NETWORK_CODES.has(code)) {
      return code;
    }
  }
  return null;
}

// Maps whatever an SDK (Anthropic or OpenAI — both expose `status` on
// APIError and name their connection errors the same way) or the network
// threw into an AiError. Anything unrecognisable is a bug on our side, not
// a provider failure, and is rethrown untouched.
export function toAiError(error: unknown): AiError {
  if (error instanceof AiError) {
    return error;
  }
  if (typeof error !== 'object' || error === null) {
    throw new Error(`Unexpected non-error thrown: ${String(error)}`);
  }
  const e = error as ErrorLike;
  const name = typeof e.name === 'string' ? e.name : '';
  const message = typeof e.message === 'string' ? e.message : '';
  const status = typeof e.status === 'number' ? e.status : undefined;
  const make = (code: AiErrorCode) =>
    new AiError(code, { providerMessage: message, status });

  if (
    name === 'AbortError' ||
    name === 'APIConnectionTimeoutError' ||
    name === 'TimeoutError' ||
    status === 408
  ) {
    return make('timeout');
  }
  if (status === 401 || status === 403) {
    return make('auth_failed');
  }
  if (status === 429) {
    return make('rate_limited');
  }
  if (status !== undefined && status >= 500) {
    return make('provider_unreachable');
  }
  if (networkCode(e) || name === 'APIConnectionError') {
    return make('provider_unreachable');
  }
  if (status !== undefined && status >= 400) {
    return make('bad_request');
  }
  // Not a provider failure — rethrow the original untouched.
  throw error as Error;
}
