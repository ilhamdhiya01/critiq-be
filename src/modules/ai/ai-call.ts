import { AiError, toAiError } from './ai-error';
import { AiProvider, AiRequest, AiResult } from './ai-provider.interface';
import { matchesSchema } from './ai-schema-validator';

const INVALID_RESPONSE_ATTEMPTS = 2;

// complete() plus schema validation, with the one retry the spec allows for
// `invalid_response` (no tool call, unparsable JSON, or JSON that does not
// match the schema). Transport retries — rate limits, timeouts — are the
// caller's policy, not this helper's: the settings test does none, the scan
// worker (step 2) gets them from BullMQ.
//
// `retryRequest` lets the caller change the request for that retry — the
// scan review appends "your previous response was not a valid call".
export async function completeValidated(
  provider: AiProvider,
  request: AiRequest,
  retryRequest: (request: AiRequest) => AiRequest = (same) => same,
): Promise<AiResult> {
  let current = request;
  for (let attempt = 1; ; attempt += 1) {
    try {
      const result = await provider.complete(current);
      if (!matchesSchema(current.tool.schema, result.toolInput)) {
        throw new AiError('invalid_response', {
          providerMessage: 'Tool input did not match the requested schema.',
          raw: result.toolInput,
        });
      }
      return result;
    } catch (error) {
      const aiError = toAiError(error);
      if (
        aiError.code === 'invalid_response' &&
        attempt < INVALID_RESPONSE_ATTEMPTS
      ) {
        current = retryRequest(request);
        continue;
      }
      throw aiError;
    }
  }
}
