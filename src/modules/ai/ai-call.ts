import { AiError, toAiError } from './ai-error';
import { AiProvider, AiRequest, AiResult } from './ai-provider.interface';
import { matchesSchema } from './ai-schema-validator';

const INVALID_RESPONSE_ATTEMPTS = 2;

// complete() plus schema validation, with the one retry the spec allows for
// `invalid_response` (no tool call, unparsable JSON, or JSON that does not
// match the schema). Transport retries — rate limits, timeouts — are the
// caller's policy, not this helper's: the settings test does none, the scan
// worker (step 2) gets them from BullMQ. `output_truncated` is never retried
// here: the same request is cut off at the same limit again.
//
// `retryRequest` lets the caller change the request for that retry — the
// scan review appends "your previous response was not a valid call".
// `normalize` runs on the tool input before the schema check and its result
// is what the caller gets — the scan review trims overlong text there.
export interface CompleteValidatedOptions {
  retryRequest?: (request: AiRequest) => AiRequest;
  normalize?: (toolInput: unknown) => unknown;
}

export async function completeValidated(
  provider: AiProvider,
  request: AiRequest,
  options: CompleteValidatedOptions = {},
): Promise<AiResult> {
  const retryRequest = options.retryRequest ?? ((same) => same);
  const normalize = options.normalize ?? ((same) => same);
  let current = request;
  for (let attempt = 1; ; attempt += 1) {
    try {
      const result = await provider.complete(current);
      const toolInput = normalize(result.toolInput);
      if (!matchesSchema(current.tool.schema, toolInput)) {
        throw new AiError('invalid_response', {
          providerMessage: 'Tool input did not match the requested schema.',
          raw: result.toolInput,
        });
      }
      return { ...result, toolInput };
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
