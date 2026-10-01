import { AiError, toAiError } from './ai-error';
import {
  AiProvider,
  AiRequest,
  AiResult,
  JsonSchema,
} from './ai-provider.interface';
import { matchesSchema } from './ai-schema-validator';

const INVALID_RESPONSE_ATTEMPTS = 2;

// complete() plus schema validation, with the one retry the spec allows for
// `invalid_response` (no tool call, unparsable JSON, or JSON that does not
// match the schema). Transport retries — rate limits, timeouts — are the
// caller's policy, not this helper's: the settings test does none, the scan
// worker (step 2) gets them from BullMQ. `output_truncated` is never retried
// here: the same request is cut off at the same limit again.
//
// `retryRequest` lets the caller change the request for that retry, seeing
// what went wrong — the scan review names the fields the model left out.
// `normalize` runs on the tool input before the schema check and its result
// is what the caller gets — the scan review trims overlong text there.
// `validationSchema` checks the answer when it may be looser than the schema
// sent to the model. `salvage` gets every attempt's tool input once the last
// one is invalid, and may assemble a usable answer from them (checked
// against the same schema) — a model that keeps dropping one field should
// not cost the whole review.
export interface CompleteValidatedOptions {
  retryRequest?: (request: AiRequest, failed: AiError) => AiRequest;
  normalize?: (toolInput: unknown) => unknown;
  validationSchema?: JsonSchema;
  salvage?: (attempts: unknown[]) => unknown;
}

export async function completeValidated(
  provider: AiProvider,
  request: AiRequest,
  options: CompleteValidatedOptions = {},
): Promise<AiResult> {
  const retryRequest = options.retryRequest ?? ((same) => same);
  const normalize = options.normalize ?? ((same) => same);
  const schema = options.validationSchema ?? request.tool.schema;
  const attempts: unknown[] = [];
  let lastResult: AiResult | null = null;
  let current = request;
  for (let attempt = 1; ; attempt += 1) {
    try {
      const result = await provider.complete(current);
      lastResult = result;
      const toolInput = normalize(result.toolInput);
      attempts.push(toolInput);
      if (!matchesSchema(schema, toolInput)) {
        throw new AiError('invalid_response', {
          providerMessage: 'Tool input did not match the requested schema.',
          // The whole message too (every tool call, any text beside it),
          // not only the arguments — kept encrypted for diagnosis.
          raw: { toolInput: result.toolInput, message: result.raw ?? null },
        });
      }
      return { ...result, toolInput };
    } catch (error) {
      const aiError = toAiError(error);
      if (aiError.code !== 'invalid_response') {
        throw aiError;
      }
      if (attempt < INVALID_RESPONSE_ATTEMPTS) {
        current = retryRequest(request, aiError);
        continue;
      }
      const salvaged = options.salvage?.(attempts);
      if (lastResult && salvaged != null && matchesSchema(schema, salvaged)) {
        return { ...lastResult, toolInput: salvaged };
      }
      throw aiError;
    }
  }
}
