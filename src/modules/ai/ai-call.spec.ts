import { completeValidated } from './ai-call';
import { AiError } from './ai-error';
import { AiProvider, AiResult } from './ai-provider.interface';
import { TEST_REQUEST } from './ai-test-fixture';

const VALID: AiResult = {
  toolInput: { summary: 'ok', findings: [] },
  usage: { inputTokens: 10, outputTokens: 5 },
  model: 'm',
  structuredOutput: 'native',
};

function provider(complete: jest.Mock): AiProvider {
  return { id: 'anthropic', complete, healthcheck: jest.fn() };
}

describe('completeValidated', () => {
  it('returns a result that matches the schema', async () => {
    const complete = jest.fn().mockResolvedValue(VALID);
    await expect(
      completeValidated(provider(complete), TEST_REQUEST),
    ).resolves.toEqual(VALID);
  });

  it('retries once when the tool input does not match the schema', async () => {
    const complete = jest
      .fn()
      .mockResolvedValueOnce({ ...VALID, toolInput: { summary: 1 } })
      .mockResolvedValueOnce(VALID);
    await expect(
      completeValidated(provider(complete), TEST_REQUEST),
    ).resolves.toEqual(VALID);
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it('gives up with invalid_response after the retry', async () => {
    const complete = jest
      .fn()
      .mockRejectedValue(new AiError('invalid_response'));
    await expect(
      completeValidated(provider(complete), TEST_REQUEST),
    ).rejects.toMatchObject({ code: 'invalid_response' });
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it('validates and returns the normalized tool input', async () => {
    const complete = jest
      .fn()
      .mockResolvedValue({ ...VALID, toolInput: { summary: 'x'.repeat(5) } });
    const normalize = jest.fn(() => ({ summary: 'short', findings: [] }));
    await expect(
      completeValidated(provider(complete), TEST_REQUEST, { normalize }),
    ).resolves.toEqual({
      ...VALID,
      toolInput: { summary: 'short', findings: [] },
    });
    expect(normalize).toHaveBeenCalledWith({ summary: 'xxxxx' });
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('does not retry a truncated answer', async () => {
    const complete = jest
      .fn()
      .mockRejectedValue(new AiError('output_truncated'));
    await expect(
      completeValidated(provider(complete), TEST_REQUEST),
    ).rejects.toMatchObject({ code: 'output_truncated' });
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('does not retry other errors', async () => {
    const complete = jest.fn().mockRejectedValue(new AiError('auth_failed'));
    await expect(
      completeValidated(provider(complete), TEST_REQUEST),
    ).rejects.toMatchObject({ code: 'auth_failed' });
    expect(complete).toHaveBeenCalledTimes(1);
  });
  // claude-sonnet-5 via an OpenAI-compatible gateway leaves out a required
  // field in about one answer in five.
  describe('with a caller that can repair answers', () => {
    const LOOSE = {
      type: 'object',
      required: ['summary'],
      properties: {
        summary: { type: 'string' },
        findings: { type: 'array' },
      },
      additionalProperties: false,
    };

    it('validates against validationSchema instead of the sent schema', async () => {
      const complete = jest
        .fn()
        .mockResolvedValue({ ...VALID, toolInput: { summary: 'ok' } });
      await expect(
        completeValidated(provider(complete), TEST_REQUEST, {
          validationSchema: LOOSE,
        }),
      ).resolves.toMatchObject({ toolInput: { summary: 'ok' } });
      expect(complete).toHaveBeenCalledTimes(1);
    });

    it('hands the first failure to retryRequest', async () => {
      const complete = jest
        .fn()
        .mockResolvedValueOnce({
          ...VALID,
          toolInput: { findings: [] },
          raw: { m: 1 },
        })
        .mockResolvedValueOnce(VALID);
      const retryRequest = jest.fn((request: typeof TEST_REQUEST) => request);

      await completeValidated(provider(complete), TEST_REQUEST, {
        retryRequest,
      });

      const [, failed] = retryRequest.mock.calls[0] as unknown as [
        unknown,
        AiError,
      ];
      expect(failed.code).toBe('invalid_response');
      expect(failed.raw).toEqual({
        toolInput: { findings: [] },
        message: { m: 1 },
      });
    });

    it('salvages from every attempt once the last one is invalid', async () => {
      const complete = jest
        .fn()
        .mockResolvedValueOnce({ ...VALID, toolInput: { summary: 'first' } })
        .mockResolvedValueOnce({ ...VALID, toolInput: { findings: [] } });
      const salvage = jest.fn((attempts: unknown[]) => ({
        summary: (attempts[0] as { summary: string }).summary,
        findings: [],
      }));

      await expect(
        completeValidated(provider(complete), TEST_REQUEST, { salvage }),
      ).resolves.toMatchObject({
        toolInput: { summary: 'first', findings: [] },
      });
      expect(salvage).toHaveBeenCalledWith([
        { summary: 'first' },
        { findings: [] },
      ]);
    });

    it('stays invalid when the salvage fails the schema or gives up', async () => {
      const complete = jest
        .fn()
        .mockResolvedValue({ ...VALID, toolInput: { nonsense: true } });
      await expect(
        completeValidated(provider(complete), TEST_REQUEST, {
          salvage: () => ({ nonsense: true }),
        }),
      ).rejects.toMatchObject({ code: 'invalid_response' });
      await expect(
        completeValidated(provider(complete), TEST_REQUEST, {
          salvage: () => null,
        }),
      ).rejects.toMatchObject({ code: 'invalid_response' });
    });

    it('does not salvage before the retry', async () => {
      const complete = jest
        .fn()
        .mockResolvedValueOnce({ ...VALID, toolInput: { findings: [] } })
        .mockResolvedValueOnce(VALID);
      const salvage = jest.fn();
      await completeValidated(provider(complete), TEST_REQUEST, { salvage });
      expect(salvage).not.toHaveBeenCalled();
    });
  });
});
