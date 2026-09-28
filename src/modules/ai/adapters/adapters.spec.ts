import { TEST_REQUEST } from '../ai-test-fixture';
import { AnthropicProvider } from './anthropic.provider';
import { OpenAiCompatibleProvider } from './openai-compatible.provider';
import { OpenAiProvider } from './openai.provider';

const mockAnthropicCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    messages: { create: mockAnthropicCreate },
  })),
}));

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
    expect(params.max_completion_tokens).toBe(300);
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
