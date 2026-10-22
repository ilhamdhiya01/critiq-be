import OpenAI from 'openai';
import { AiError, toAiError } from '../ai-error';
import {
  AiModelInfo,
  AiProviderConfig,
  AiProviderName,
  AiRequest,
} from '../ai-provider.interface';
import { OpenAiCompatibleProvider } from './openai-compatible.provider';

// Google's own OpenAI-compatible endpoint for Gemini. Fixed here, never
// taken from the organization, so it needs no SSRF check.
export const GEMINI_OPENAI_BASE_URL =
  'https://generativelanguage.googleapis.com/v1beta/openai/';

// Gemini's /models also lists embedding, speech, image and Live API
// models; only the chat ones can review a diff.
const GEMINI_NON_CHAT_MODEL = /embedding|tts|image|live|audio/i;

// Google answers a wrong key with 400 INVALID_ARGUMENT, not 401 — in the
// message, or only in the error body (reason API_KEY_INVALID).
const INVALID_KEY = /API[ _]key not valid|API_KEY_INVALID/i;

// Gemini through its OpenAI-compatible API, with the openai SDK already
// used for OpenAI and gateways — no Google SDK. Inherits the compatible
// adapter's JSON-mode fallback, max_tokens and healthcheck; differs in a
// fixed base URL, a non-strict tool schema, Gemini-only model listing and
// how a rejected key is reported.
export class GoogleProvider extends OpenAiCompatibleProvider {
  override readonly id: AiProviderName = 'google';

  constructor(config: AiProviderConfig) {
    super({ ...config, baseUrl: GEMINI_OPENAI_BASE_URL });
  }

  // Gemini names its models "models/gemini-…"; the chat API takes the
  // bare name, so that is what the picker gets.
  override async listModels(): Promise<AiModelInfo[]> {
    const models = await super.listModels();
    return models
      .map((model) => {
        const id = model.id.replace(/^models\//, '');
        return { ...model, id, label: id };
      })
      .filter(
        (model) =>
          model.id.startsWith('gemini-') &&
          !GEMINI_NON_CHAT_MODEL.test(model.id),
      );
  }

  // Strict mode and its rewritten schema (every property required, nulls
  // as type unions) are OpenAI features; Gemini takes the schema as is.
  protected override toolFunction(req: AiRequest): OpenAI.FunctionDefinition {
    return {
      name: req.tool.name,
      description: req.tool.description,
      parameters: req.tool.schema,
    };
  }

  // Without this a wrong key reads "bad request" to the Admin, and the
  // worker never raises its auth alert.
  protected override mapError(error: unknown): AiError {
    const mapped = toAiError(error);
    if (mapped.code !== 'bad_request' || mapped.status !== 400) {
      return mapped;
    }
    const body = JSON.stringify((error as { error?: unknown }).error ?? null);
    if (
      !INVALID_KEY.test(mapped.providerMessage ?? '') &&
      !INVALID_KEY.test(body)
    ) {
      return mapped;
    }
    return new AiError('auth_failed', {
      providerMessage: mapped.providerMessage,
      status: mapped.status,
    });
  }
}
