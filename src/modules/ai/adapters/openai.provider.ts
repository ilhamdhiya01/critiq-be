import OpenAI from 'openai';
import { AiError, toAiError } from '../ai-error';
import {
  AiProvider,
  AiProviderConfig,
  AiProviderName,
  AiRequest,
  AiResult,
} from '../ai-provider.interface';
import { toStrictSchema } from '../json-schema';

export const HEALTHCHECK_TIMEOUT_MS = 15_000;

export function parseJsonOrThrow(text: string | null | undefined): unknown {
  const raw = text ?? '';
  // Some servers wrap JSON-mode output in a markdown fence despite being
  // told not to; unwrap it before parsing.
  const unfenced = (text ?? '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  try {
    return JSON.parse(unfenced);
  } catch {
    throw new AiError('invalid_response', {
      providerMessage: 'Response was not valid JSON.',
      raw,
    });
  }
}

export function usageOf(response: OpenAI.Chat.ChatCompletion) {
  return {
    inputTokens: response.usage?.prompt_tokens ?? 0,
    outputTokens: response.usage?.completion_tokens ?? 0,
  };
}

// finish_reason "length": the answer stopped at max_tokens, so the tool
// arguments (or JSON) are cut off — a clearer failure than the parse error
// it would otherwise become.
export function throwIfTruncated(
  response: OpenAI.Chat.ChatCompletion,
  maxTokens: number,
): void {
  const choice = response.choices[0];
  if (choice?.finish_reason === 'length') {
    throw new AiError('output_truncated', {
      providerMessage: `Response hit max_tokens (${maxTokens}).`,
      raw: choice.message ?? null,
    });
  }
}

export class OpenAiProvider implements AiProvider {
  readonly id: AiProviderName = 'openai';
  protected readonly client: OpenAI;

  constructor(protected readonly config: AiProviderConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey ?? '',
      baseURL: config.baseUrl ?? undefined,
      maxRetries: 0,
    });
  }

  async complete(req: AiRequest): Promise<AiResult> {
    try {
      return await this.completeWithTools(req);
    } catch (error) {
      throw toAiError(error);
    }
  }

  async healthcheck(): Promise<{ model: string }> {
    try {
      const model = await this.client.models.retrieve(this.config.model, {
        timeout: HEALTHCHECK_TIMEOUT_MS,
      });
      return { model: model.id };
    } catch (error) {
      throw toAiError(error);
    }
  }

  // Current OpenAI models take max_completion_tokens; older OpenAI-shaped
  // servers only know max_tokens — the compatible adapter overrides this.
  protected maxTokensParam(maxTokens: number): {
    max_completion_tokens?: number;
    max_tokens?: number;
  } {
    return { max_completion_tokens: maxTokens };
  }

  protected async completeWithTools(req: AiRequest): Promise<AiResult> {
    const response = await this.client.chat.completions.create(
      {
        model: this.config.model,
        temperature: req.temperature,
        ...this.maxTokensParam(req.maxTokens),
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.user },
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: req.tool.name,
              description: req.tool.description,
              parameters: toStrictSchema(req.tool.schema),
              strict: true,
            },
          },
        ],
        tool_choice: { type: 'function', function: { name: req.tool.name } },
      },
      { timeout: req.timeoutMs },
    );
    throwIfTruncated(response, req.maxTokens);
    const call = response.choices[0]?.message?.tool_calls?.[0];
    if (!call || call.type !== 'function') {
      throw new AiError('invalid_response', {
        providerMessage: 'Response contained no function tool call.',
        raw: response.choices[0]?.message ?? null,
      });
    }
    return {
      toolInput: parseJsonOrThrow(call.function.arguments),
      usage: usageOf(response),
      model: response.model,
      structuredOutput: 'native',
    };
  }
}
