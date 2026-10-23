import { AiProviderId } from '../../generated/prisma/enums';
import {
  AI_PROVIDER_CATALOG,
  AI_PROVIDER_NAMES,
  defaultModelFor,
  toProviderEnum,
  toProviderName,
} from './ai-models.constants';

describe('AI provider names', () => {
  it.each([
    ['anthropic', AiProviderId.ANTHROPIC],
    ['openai', AiProviderId.OPENAI],
    ['openai_compatible', AiProviderId.OPENAI_COMPATIBLE],
    ['google', AiProviderId.GOOGLE],
  ] as const)('%s ↔ %s', (name, id) => {
    expect(toProviderEnum(name)).toBe(id);
    expect(toProviderName(id)).toBe(name);
  });

  // Every provider the database knows can be selected and validated.
  it('covers every database provider', () => {
    expect([...AI_PROVIDER_NAMES].map(toProviderEnum).sort()).toEqual(
      Object.values(AiProviderId).sort(),
    );
  });

  it('offers every catalog provider', () => {
    expect(AI_PROVIDER_CATALOG.every((entry) => entry.available)).toBe(true);
  });

  it('defaults google to a Gemini model', () => {
    expect(defaultModelFor('google')).toBe('gemini-3.8-flash');
  });
});
