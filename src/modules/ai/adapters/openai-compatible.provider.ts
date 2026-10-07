import { toAiError } from '../ai-error';
import {
  AiModelInfo,
  AiProviderConfig,
  AiProviderName,
  AiRequest,
  AiResult,
} from '../ai-provider.interface';
import {
  HEALTHCHECK_TIMEOUT_MS,
  listChatModels,
  OpenAiProvider,
  parseJsonOrThrow,
  throwIfTruncated,
  usageOf,
  usedReasoning,
} from './openai.provider';

// A 400/404 whose message names tools or function calling: the server (an
// older vLLM, Ollama, some gateways) does not support them. Anything else —
// a bad model name, a context overflow — is a real error, not a cue to
// fall back.
function rejectsTools(error: unknown): boolean {
  const e = error as { status?: unknown; message?: unknown };
  return (
    (e.status === 400 || e.status === 404) &&
    typeof e.message === 'string' &&
    /tool|function/i.test(e.message)
  );
}

// vLLM, Ollama (/v1), LM Studio, OpenRouter, LiteLLM — anything speaking
// the OpenAI chat API at a custom base URL. The key is optional: a
// self-hosted server often needs none, but the SDK insists on a string.
export class OpenAiCompatibleProvider extends OpenAiProvider {
  override readonly id: AiProviderName = 'openai_compatible';

  constructor(config: AiProviderConfig) {
    super({ ...config, apiKey: config.apiKey ?? 'none' });
  }

  override async complete(req: AiRequest): Promise<AiResult> {
    try {
      return await this.completeWithTools(req);
    } catch (error) {
      if (!rejectsTools(error)) {
        throw toAiError(error);
      }
    }
    try {
      return await this.completeJsonMode(req);
    } catch (error) {
      throw toAiError(error);
    }
  }

  // GET {baseURL}/models; servers without that route get a one-token
  // completion instead.
  override async healthcheck(): Promise<{ model: string }> {
    try {
      await this.client.models.list({ timeout: HEALTHCHECK_TIMEOUT_MS });
      return { model: this.config.model };
    } catch (error) {
      if ((error as { status?: unknown }).status !== 404) {
        throw toAiError(error);
      }
    }
    try {
      const response = await this.client.chat.completions.create(
        {
          model: this.config.model,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }],
        },
        { timeout: HEALTHCHECK_TIMEOUT_MS },
      );
      return { model: response.model };
    } catch (error) {
      throw toAiError(error);
    }
  }

  // GET {baseURL}/models — a gateway lists what it serves (SumoPod: OpenAI
  // and Claude models alike), so its names are kept, non-chat ones dropped.
  override async listModels(): Promise<AiModelInfo[]> {
    try {
      return await listChatModels(this.client, false);
    } catch (error) {
      throw toAiError(error);
    }
  }

  protected override maxTokensParam(maxTokens: number) {
    return { max_tokens: maxTokens };
  }

  private async completeJsonMode(req: AiRequest): Promise<AiResult> {
    const response = await this.client.chat.completions.create(
      {
        model: this.config.model,
        temperature: req.temperature,
        max_tokens: req.maxTokens,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content:
              `${req.system}\n\n` +
              `Reply with one JSON object and nothing else — no prose, no ` +
              `code fence. It is the input of the "${req.tool.name}" tool ` +
              `and must match this JSON Schema:\n` +
              JSON.stringify(req.tool.schema),
          },
          { role: 'user', content: req.user },
        ],
      },
      { timeout: req.timeoutMs },
    );
    throwIfTruncated(response, req.maxTokens);
    const usage = usageOf(response);
    return {
      toolInput: parseJsonOrThrow(response.choices[0]?.message?.content, usage),
      usage,
      model: response.model,
      structuredOutput: 'json_mode',
      reasoning: usedReasoning(response),
      raw: response.choices[0]?.message ?? null,
    };
  }
}
