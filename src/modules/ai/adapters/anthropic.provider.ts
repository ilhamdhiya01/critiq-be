import Anthropic from '@anthropic-ai/sdk';
import { AiError, toAiError } from '../ai-error';
import {
  AiProvider,
  AiProviderConfig,
  AiRequest,
  AiResult,
} from '../ai-provider.interface';

const HEALTHCHECK_TIMEOUT_MS = 15_000;

type InputSchema = Anthropic.Messages.Tool['input_schema'];

export class AnthropicProvider implements AiProvider {
  readonly id = 'anthropic' as const;
  private readonly client: Anthropic;

  constructor(private readonly config: AiProviderConfig) {
    // SDK-level retries off: retry policy belongs to the caller, and a
    // hidden retry would double-bill a rate-limited organization.
    this.client = new Anthropic({ apiKey: config.apiKey ?? '', maxRetries: 0 });
  }

  async complete(req: AiRequest): Promise<AiResult> {
    try {
      const response = await this.client.messages.create(
        {
          model: this.config.model,
          max_tokens: req.maxTokens,
          temperature: req.temperature,
          system: req.system,
          messages: [{ role: 'user', content: req.user }],
          tools: [
            {
              name: req.tool.name,
              description: req.tool.description,
              input_schema: req.tool.schema as InputSchema,
            },
          ],
          tool_choice: { type: 'tool', name: req.tool.name },
        },
        { timeout: req.timeoutMs },
      );
      const toolUse = response.content.find(
        (block) => block.type === 'tool_use',
      );
      if (!toolUse || toolUse.type !== 'tool_use') {
        throw new AiError('invalid_response', {
          providerMessage: 'Response contained no tool_use block.',
          raw: response.content,
        });
      }
      return {
        toolInput: toolUse.input,
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        },
        model: response.model,
        structuredOutput: 'native',
      };
    } catch (error) {
      throw toAiError(error);
    }
  }

  // One output token: proves key, model and reachability for a fraction of
  // a cent.
  async healthcheck(): Promise<{ model: string }> {
    try {
      const response = await this.client.messages.create(
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
}
