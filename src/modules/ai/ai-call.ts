import { AiError, toAiError } from './ai-error';
import {
  AiProvider,
  AiRequest,
  AiResult,
  AiUsage,
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
//
// `usage` is the total of every attempt, on the result and on the error
// finally thrown: a failed attempt is billed too, and the daily budget has
// to see it.
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
  const spent: AiUsage = { inputTokens: 0, outputTokens: 0 };
  const addUsage = (usage: AiUsage | undefined) => {
    spent.inputTokens += usage?.inputTokens ?? 0;
    spent.outputTokens += usage?.outputTokens ?? 0;
  };
  const withSpent = (error: AiError) =>
    spent.inputTokens + spent.outputTokens > 0 ? error.withUsage(spent) : error;
  let lastResult: AiResult | null = null;
  let current = request;
  for (let attempt = 1; ; attempt += 1) {
    try {
      const result = await provider.complete(current);
      addUsage(result.usage);
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
      return { ...result, toolInput, usage: { ...spent } };
    } catch (error) {
      const aiError = toAiError(error);
      // Set by the adapter when a response came back but was unusable; a
      // schema mismatch above was already counted from the result.
      addUsage(aiError.usage);
      if (aiError.code !== 'invalid_response') {
        throw withSpent(aiError);
      }
      if (attempt < INVALID_RESPONSE_ATTEMPTS) {
        current = retryRequest(request, aiError);
        continue;
      }
      const salvaged = options.salvage?.(attempts);
      if (lastResult && salvaged != null && matchesSchema(schema, salvaged)) {
        return { ...lastResult, toolInput: salvaged, usage: { ...spent } };
      }
      throw withSpent(aiError);
    }
  }
}
