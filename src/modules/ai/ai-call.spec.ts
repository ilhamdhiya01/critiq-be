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
    ).resolves.toBe(VALID);
  });

  it('retries once when the tool input does not match the schema', async () => {
    const complete = jest
      .fn()
      .mockResolvedValueOnce({ ...VALID, toolInput: { summary: 1 } })
      .mockResolvedValueOnce(VALID);
    await expect(
      completeValidated(provider(complete), TEST_REQUEST),
    ).resolves.toBe(VALID);
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

  it('does not retry other errors', async () => {
    const complete = jest.fn().mockRejectedValue(new AiError('auth_failed'));
    await expect(
      completeValidated(provider(complete), TEST_REQUEST),
    ).rejects.toMatchObject({ code: 'auth_failed' });
    expect(complete).toHaveBeenCalledTimes(1);
  });
});
