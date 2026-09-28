import { AiError, toAiError } from './ai-error';
import { AiProvider, AiRequest, AiResult } from './ai-provider.interface';
import { matchesSchema } from './ai-schema-validator';

const INVALID_RESPONSE_ATTEMPTS = 2;

// complete() plus schema validation, with the one retry the spec allows for
// `invalid_response` (no tool call, unparsable JSON, or JSON that does not
// match the schema). Transport retries — rate limits, timeouts — are the
// caller's policy, not this helper's: the settings test does none, the scan
// worker (step 2) gets them from BullMQ.
export async function completeValidated(
  provider: AiProvider,
  request: AiRequest,
): Promise<AiResult> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const result = await provider.complete(request);
      if (!matchesSchema(request.tool.schema, result.toolInput)) {
        throw new AiError('invalid_response', {
          providerMessage: 'Tool input did not match the requested schema.',
        });
      }
      return result;
    } catch (error) {
      const aiError = toAiError(error);
      if (
        aiError.code === 'invalid_response' &&
        attempt < INVALID_RESPONSE_ATTEMPTS
      ) {
        continue;
      }
      throw aiError;
    }
  }
}
