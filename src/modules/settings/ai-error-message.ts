import { AiError, AiErrorCode } from '../ai/ai-error';

// What an Admin sees for each failure. Built from the code, never from the
// provider's own text, except for bad_request where the (sanitized) reason
// is the only useful information.
export function aiErrorMessage(error: AiError): string {
  const status = error.status ? ` (${error.status})` : '';
  const messages: Record<AiErrorCode, string> = {
    auth_failed: `Provider rejected the API key${status}.`,
    rate_limited: `Provider rate limit reached${status}. Try again later.`,
    timeout: 'Provider did not respond in time.',
    provider_unreachable: `Provider could not be reached${status}.`,
    invalid_response:
      'Provider replied, but not with a valid structured result.',
    output_truncated:
      'Provider stopped at the output token limit before finishing the result.',
    reasoning_exhausted:
      'The model spent its whole output budget on reasoning before answering. Split the pull request or choose another model.',
    bad_request: `Provider rejected the request${status}: ${error.providerMessage ?? ''}`,
    insecure_base_url: error.providerMessage ?? 'Base URL is not allowed.',
    not_configured: error.providerMessage ?? 'No AI provider is configured.',
    api_key_required: 'An API key is required for this provider.',
    base_url_required: 'A base URL is required for this provider.',
  };
  return messages[error.code];
}
