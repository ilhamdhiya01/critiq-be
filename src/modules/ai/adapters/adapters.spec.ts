import { TEST_REQUEST } from '../ai-test-fixture';
import { AnthropicProvider } from './anthropic.provider';
import { OpenAiCompatibleProvider } from './openai-compatible.provider';
import { OpenAiProvider } from './openai.provider';

const mockAnthropicCreate = jest.fn();
const mockAnthropicModelsList = jest.fn();
jest.mock('@anthropic-ai/sdk', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    messages: { create: mockAnthropicCreate },
    models: { list: mockAnthropicModelsList },
  })),
}));

// What the SDKs' list() returns: an auto-paginating async iterable.
function pages<T>(items: T[]): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const item of items) {
        yield await Promise.resolve(item);
      }
    },
  };
}

function failingPages(error: Error): AsyncIterable<never> {
  return {
    [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(error) }),
  };
}

const mockChatCreate = jest.fn();
const mockModelsRetrieve = jest.fn();
const mockModelsList = jest.fn();
const mockOpenAiConstructor = jest.fn();
jest.mock('openai', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation((options: unknown) => {
    mockOpenAiConstructor(options);
    return {
      chat: { completions: { create: mockChatCreate } },
      models: { retrieve: mockModelsRetrieve, list: mockModelsList },
    };
  }),
}));

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status, name: 'APIError' });
}

const TOOL_INPUT = {
  summary: 'TLS verification is disabled.',
  findings: [{ file: 'src/http/client.ts', line: 10, title: 'Insecure TLS' }],
};

beforeEach(() => jest.clearAllMocks());

describe('AnthropicProvider', () => {
  const provider = new AnthropicProvider({
    model: 'claude-sonnet-5',
    apiKey: 'test-key',
    baseUrl: null,
  });

  // Acceptance 2.
  it('forces the tool and returns its input as native structured output', async () => {
    mockAnthropicCreate.mockResolvedValue({
      model: 'claude-sonnet-5',
      content: [
        { type: 'tool_use', name: 'report_review_test', input: TOOL_INPUT },
      ],
      usage: { input_tokens: 410, output_tokens: 62 },
    });

    const result = await provider.complete(TEST_REQUEST);

    expect(result).toEqual({
      toolInput: TOOL_INPUT,
      usage: { inputTokens: 410, outputTokens: 62 },
      model: 'claude-sonnet-5',
      structuredOutput: 'native',
      // Every content block, for the encrypted raw response on failure.
      raw: [
        { type: 'tool_use', name: 'report_review_test', input: TOOL_INPUT },
      ],
    });
    const [params] = mockAnthropicCreate.mock.calls[0] as [
      Record<string, unknown>,
    ];
    expect(params.tool_choice).toEqual({
      type: 'tool',
      name: 'report_review_test',
    });
  });

  // Acceptance 3.
  it.each([
    [httpError(401, 'invalid x-api-key'), 'auth_failed'],
    [httpError(529, 'Overloaded'), 'provider_unreachable'],
  ])('maps %s to %s', async (error, code) => {
    mockAnthropicCreate.mockRejectedValue(error);
    await expect(provider.complete(TEST_REQUEST)).rejects.toMatchObject({
      code,
    });
  });

  it('reports invalid_response when no tool_use block comes back', async () => {
    mockAnthropicCreate.mockResolvedValue({
      model: 'claude-sonnet-5',
      content: [{ type: 'text', text: 'Looks fine to me.' }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    await expect(provider.complete(TEST_REQUEST)).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });

  it('reports output_truncated when the answer stops at max_tokens', async () => {
    mockAnthropicCreate.mockResolvedValue({
      model: 'claude-sonnet-5',
      stop_reason: 'max_tokens',
      content: [
        {
          type: 'tool_use',
          name: 'report_review_test',
          input: { summary: '' },
        },
      ],
      usage: { input_tokens: 900, output_tokens: 1000 },
    });
    await expect(provider.complete(TEST_REQUEST)).rejects.toMatchObject({
      code: 'output_truncated',
      retryable: false,
      // Billed although unusable.
      usage: { inputTokens: 900, outputTokens: 1000 },
    });
  });

  it('carries the billed tokens on invalid_response', async () => {
    mockAnthropicCreate.mockResolvedValue({
      model: 'claude-sonnet-5',
      content: [{ type: 'text', text: 'Looks fine to me.' }],
      usage: { input_tokens: 700, output_tokens: 20 },
    });
    await expect(provider.complete(TEST_REQUEST)).rejects.toMatchObject({
      usage: { inputTokens: 700, outputTokens: 20 },
    });
  });

  it('healthchecks with a one-token message', async () => {
    mockAnthropicCreate.mockResolvedValue({ model: 'claude-sonnet-5' });
    await expect(provider.healthcheck()).resolves.toEqual({
      model: 'claude-sonnet-5',
    });
    const [params] = mockAnthropicCreate.mock.calls[0] as [
      Record<string, unknown>,
    ];
    expect(params.max_tokens).toBe(1);
  });
});

function toolCallResponse(args: unknown) {
  return {
    model: 'gpt-4o',
    choices: [
      {
        message: {
          tool_calls: [
            {
              type: 'function',
              function: {
                name: 'report_review_test',
                arguments: JSON.stringify(args),
              },
            },
          ],
        },
      },
    ],
    usage: { prompt_tokens: 300, completion_tokens: 40 },
  };
}

describe('OpenAiProvider', () => {
  const provider = new OpenAiProvider({
    model: 'gpt-4o',
    apiKey: 'k',
    baseUrl: null,
  });

  it('sends a strict function tool and parses its arguments', async () => {
    mockChatCreate.mockResolvedValue(toolCallResponse(TOOL_INPUT));

    const result = await provider.complete(TEST_REQUEST);

    expect(result.toolInput).toEqual(TOOL_INPUT);
    expect(result.structuredOutput).toBe('native');
    // The whole message (every tool call, any text) travels as `raw`.
    expect(result.raw).toMatchObject({ tool_calls: [expect.anything()] });
    const [params] = mockChatCreate.mock.calls[0] as [
      {
        tools: {
          function: { strict: boolean; parameters: Record<string, unknown> };
        }[];
        max_completion_tokens: number;
      },
    ];
    expect(params.tools[0].function.strict).toBe(true);
    expect(params.tools[0].function.parameters.additionalProperties).toBe(
      false,
    );
    expect(params.max_completion_tokens).toBe(TEST_REQUEST.maxTokens);
  });

  it('reports output_truncated when finish_reason is length', async () => {
    const response = toolCallResponse(TOOL_INPUT);
    mockChatCreate.mockResolvedValue({
      ...response,
      choices: [{ ...response.choices[0], finish_reason: 'length' }],
    });
    await expect(provider.complete(TEST_REQUEST)).rejects.toMatchObject({
      code: 'output_truncated',
      usage: { inputTokens: 300, outputTokens: 40 },
    });
  });

  it('carries the billed tokens when no tool call comes back', async () => {
    mockChatCreate.mockResolvedValue({
      model: 'gpt-4o',
      choices: [{ message: { content: 'Looks fine.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 300, completion_tokens: 5 },
    });
    await expect(provider.complete(TEST_REQUEST)).rejects.toMatchObject({
      code: 'invalid_response',
      usage: { inputTokens: 300, outputTokens: 5 },
    });
  });

  it('is not marked reasoning without reasoning tokens or text', async () => {
    mockChatCreate.mockResolvedValue(toolCallResponse(TOOL_INPUT));
    const result = await provider.complete(TEST_REQUEST);
    expect(result.reasoning).toBe(false);
  });

  // OpenAI's own reasoning models report a count, not text.
  it('is marked reasoning from reasoning_tokens', async () => {
    const response = toolCallResponse(TOOL_INPUT);
    mockChatCreate.mockResolvedValue({
      ...response,
      usage: {
        ...response.usage,
        completion_tokens_details: { reasoning_tokens: 512 },
      },
    });
    const result = await provider.complete(TEST_REQUEST);
    expect(result.reasoning).toBe(true);
  });

  it('healthchecks by retrieving the model', async () => {
    mockModelsRetrieve.mockResolvedValue({ id: 'gpt-4o' });
    await expect(provider.healthcheck()).resolves.toEqual({ model: 'gpt-4o' });
  });
});

describe('OpenAiCompatibleProvider', () => {
  const provider = new OpenAiCompatibleProvider({
    model: 'llama-3.1-70b-instruct',
    apiKey: null,
    baseUrl: 'https://vllm.example.com/v1',
  });

  it('sends the base URL and a placeholder key when none is set', () => {
    new OpenAiCompatibleProvider({
      model: 'm',
      apiKey: null,
      baseUrl: 'https://vllm.example.com/v1',
    });
    expect(mockOpenAiConstructor).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'none',
        baseURL: 'https://vllm.example.com/v1',
      }),
    );
  });

  // Acceptance 4.
  it('falls back to JSON mode when the server rejects tools', async () => {
    mockChatCreate
      .mockRejectedValueOnce(httpError(400, 'tools is not supported'))
      .mockResolvedValueOnce({
        model: 'llama-3.1-70b-instruct',
        choices: [
          {
            message: {
              content: '```json\n' + JSON.stringify(TOOL_INPUT) + '\n```',
            },
          },
        ],
        usage: { prompt_tokens: 500, completion_tokens: 80 },
      });

    const result = await provider.complete(TEST_REQUEST);

    expect(result.structuredOutput).toBe('json_mode');
    expect(result.toolInput).toEqual(TOOL_INPUT);
    const [fallback] = mockChatCreate.mock.calls[1] as [
      Record<string, unknown>,
    ];
    expect(fallback.response_format).toEqual({ type: 'json_object' });
    expect(fallback.tools).toBeUndefined();
  });

  it('does not fall back on an unrelated 400', async () => {
    mockChatCreate.mockRejectedValue(httpError(400, 'model not found'));
    await expect(provider.complete(TEST_REQUEST)).rejects.toMatchObject({
      code: 'bad_request',
    });
    expect(mockChatCreate).toHaveBeenCalledTimes(1);
  });

  it('reports invalid_response when JSON mode returns prose', async () => {
    mockChatCreate
      .mockRejectedValueOnce(httpError(400, 'tool_choice is not supported'))
      .mockResolvedValueOnce({
        model: 'm',
        choices: [{ message: { content: 'Sure! The diff looks fine.' } }],
      });
    await expect(provider.complete(TEST_REQUEST)).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });

  it('reports output_truncated when JSON mode stops at max_tokens', async () => {
    mockChatCreate
      .mockRejectedValueOnce(httpError(400, 'tools is not supported'))
      .mockResolvedValueOnce({
        model: 'm',
        choices: [
          { message: { content: '{"summary": "cut' }, finish_reason: 'length' },
        ],
      });
    await expect(provider.complete(TEST_REQUEST)).rejects.toMatchObject({
      code: 'output_truncated',
    });
  });

  // deepseek-v4-flash on a 48 KB diff (MR !1792): the whole budget went to
  // reasoning_content, no tool call, no content.
  it('reports reasoning_exhausted when only reasoning was written', async () => {
    mockChatCreate.mockResolvedValue({
      model: 'deepseek-v4-flash',
      choices: [
        {
          message: {
            role: 'assistant',
            content: '',
            reasoning_content: 'Let me look at each file in turn…',
          },
          finish_reason: 'length',
        },
      ],
      usage: { prompt_tokens: 40000, completion_tokens: 1000 },
    });
    await expect(provider.complete(TEST_REQUEST)).rejects.toMatchObject({
      code: 'reasoning_exhausted',
      retryable: false,
      usage: { inputTokens: 40000, outputTokens: 1000 },
      raw: { reasoning_content: expect.any(String) as unknown },
    });
  });

  // A tool call was started: the answer itself ran long.
  it('keeps output_truncated when reasoning came with a cut-off tool call', async () => {
    const response = toolCallResponse(TOOL_INPUT);
    mockChatCreate.mockResolvedValue({
      ...response,
      choices: [
        {
          message: { ...response.choices[0].message, reasoning: 'Thinking…' },
          finish_reason: 'length',
        },
      ],
    });
    await expect(provider.complete(TEST_REQUEST)).rejects.toMatchObject({
      code: 'output_truncated',
    });
  });

  it('is marked reasoning from reasoning text beside the answer', async () => {
    const response = toolCallResponse(TOOL_INPUT);
    mockChatCreate.mockResolvedValue({
      ...response,
      choices: [
        {
          message: {
            ...response.choices[0].message,
            reasoning_content: 'The diff adds…',
          },
          finish_reason: 'tool_calls',
        },
      ],
    });
    const result = await provider.complete(TEST_REQUEST);
    expect(result.reasoning).toBe(true);
  });

  it('healthchecks via /models, falling back to a completion on 404', async () => {
    mockModelsList.mockRejectedValueOnce(httpError(404, 'Not Found'));
    mockChatCreate.mockResolvedValueOnce({
      model: 'llama-3.1-70b-instruct',
      choices: [],
    });
    await expect(provider.healthcheck()).resolves.toEqual({
      model: 'llama-3.1-70b-instruct',
    });
  });

  it('maps a refused connection to provider_unreachable', async () => {
    mockModelsList.mockRejectedValueOnce(
      Object.assign(new Error('connect ECONNREFUSED'), {
        name: 'APIConnectionError',
        cause: { code: 'ECONNREFUSED' },
      }),
    );
    await expect(provider.healthcheck()).rejects.toMatchObject({
      code: 'provider_unreachable',
    });
  });
});

describe('listModels', () => {
  it('Anthropic: every model, with its name and context window', async () => {
    mockAnthropicModelsList.mockReturnValue(
      pages([
        {
          id: 'claude-opus-5-5',
          display_name: 'Claude Opus 5.5',
          created_at: '2026-08-01T00:00:00Z',
          max_input_tokens: 1_000_000,
        },
        {
          id: 'claude-haiku-4-5',
          display_name: 'Claude Haiku 4.5',
          created_at: '2025-10-01T00:00:00Z',
          max_input_tokens: null,
        },
      ]),
    );
    const provider = new AnthropicProvider({
      model: 'm',
      apiKey: 'k',
      baseUrl: null,
    });

    await expect(provider.listModels()).resolves.toEqual([
      {
        id: 'claude-opus-5-5',
        label: 'Claude Opus 5.5',
        contextWindow: 1_000_000,
        createdAt: new Date('2026-08-01T00:00:00Z'),
      },
      {
        id: 'claude-haiku-4-5',
        label: 'Claude Haiku 4.5',
        contextWindow: null,
        createdAt: new Date('2025-10-01T00:00:00Z'),
      },
    ]);
  });

  it('Anthropic: a refused key is auth_failed', async () => {
    mockAnthropicModelsList.mockReturnValue(
      failingPages(httpError(401, 'invalid x-api-key')),
    );
    const provider = new AnthropicProvider({
      model: 'm',
      apiKey: 'k',
      baseUrl: null,
    });
    await expect(provider.listModels()).rejects.toMatchObject({
      code: 'auth_failed',
    });
  });

  // OpenAI lists embeddings, speech, images… with no capability field.
  it('OpenAI: only its chat models', async () => {
    mockModelsList.mockReturnValue(
      pages([
        { id: 'gpt-4o', created: 1_715_000_000 },
        { id: 'text-embedding-3-small', created: 1_705_000_000 },
        { id: 'whisper-1', created: 1_677_000_000 },
        { id: 'o4-mini', created: 1_744_000_000 },
        { id: 'dall-e-3', created: 1_698_000_000 },
        { id: 'gpt-4o-realtime-preview', created: 1_727_000_000 },
        { id: 'babbage-002', created: 1_692_000_000 },
      ]),
    );
    const provider = new OpenAiProvider({
      model: 'm',
      apiKey: 'k',
      baseUrl: null,
    });

    const models = await provider.listModels();

    expect(models.map((model) => model.id)).toEqual(['gpt-4o', 'o4-mini']);
    expect(models[0]).toEqual({
      id: 'gpt-4o',
      label: 'gpt-4o',
      contextWindow: null,
      createdAt: new Date(1_715_000_000 * 1000),
    });
  });

  // A gateway's names are its own (SumoPod serves Claude as well).
  it('OpenAI-compatible: what the gateway serves, minus non-chat models', async () => {
    mockModelsList.mockReturnValue(
      pages([
        { id: 'gpt-4o-mini', created: 0 },
        { id: 'claude-sonnet-5', created: 0 },
        { id: 'llama-3.1-70b-instruct', created: 0 },
        { id: 'text-embedding-3-large', created: 0 },
      ]),
    );
    const provider = new OpenAiCompatibleProvider({
      model: 'm',
      apiKey: null,
      baseUrl: 'https://ai.example.com/v1',
    });

    const models = await provider.listModels();

    expect(models.map((model) => model.id)).toEqual([
      'gpt-4o-mini',
      'claude-sonnet-5',
      'llama-3.1-70b-instruct',
    ]);
    // `created: 0` is "unknown", not 1970.
    expect(models[0].createdAt).toBeNull();
  });
});
