import { AiProviderId } from '../../generated/prisma/enums';
import { AiProviderName } from './ai-provider.interface';

// Suggestions for the Settings dropdown, not a whitelist — the FE may send
// any model name ("custom"). Kept in one place so a model release is a
// one-line change. Anthropic uses the current family rather than the older
// names in the v1.5.1 prompt (claude-sonnet-4-5, claude-opus-4-1) — see
// CLAUDE.md "Hal usang".
export interface ProviderCatalogEntry {
  id: AiProviderName | 'google';
  label: string;
  available: boolean;
  defaultModel?: string | null;
  models?: string[];
  needsBaseUrl?: boolean;
  keyOptional?: boolean;
  testedModels?: string[];
}

export const AI_PROVIDER_CATALOG: ProviderCatalogEntry[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    available: true,
    defaultModel: 'claude-sonnet-5',
    models: ['claude-sonnet-5', 'claude-opus-5-5', 'claude-haiku-4-5-20251001'],
  },
  {
    id: 'openai',
    label: 'OpenAI',
    available: true,
    defaultModel: 'gpt-4o',
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1'],
  },
  {
    id: 'openai_compatible',
    label: 'OpenAI-compatible (self-hosted / gateway)',
    available: true,
    defaultModel: null,
    models: [],
    needsBaseUrl: true,
    keyOptional: true,
    testedModels: ['llama-3.1-70b-instruct', 'qwen2.5-coder-32b-instruct'],
  },
  { id: 'google', label: 'Google', available: false },
];

// Models tested to review well in Critiq — the picker's "recommended"
// badge. Anthropic/OpenAI: the catalog's suggestions above (minus the
// pricier gpt-4.1 for OpenAI). openai_compatible: gpt-4o-mini, proven
// through SumoPod (claude-sonnet-5 through the same gateway leaves required
// fields out about one answer in five), plus the self-hosted models tested.
export const RECOMMENDED_MODELS: Record<AiProviderName, readonly string[]> = {
  anthropic: [
    'claude-sonnet-5',
    'claude-opus-5-5',
    'claude-haiku-4-5-20251001',
  ],
  openai: ['gpt-4o', 'gpt-4o-mini'],
  openai_compatible: [
    'gpt-4o-mini',
    'llama-3.1-70b-instruct',
    'qwen2.5-coder-32b-instruct',
  ],
};

export function defaultModelFor(provider: AiProviderName): string | null {
  return (
    AI_PROVIDER_CATALOG.find((entry) => entry.id === provider)?.defaultModel ??
    null
  );
}

const TO_ENUM: Record<AiProviderName, AiProviderId> = {
  anthropic: AiProviderId.ANTHROPIC,
  openai: AiProviderId.OPENAI,
  openai_compatible: AiProviderId.OPENAI_COMPATIBLE,
};

export const AI_PROVIDER_NAMES = Object.keys(TO_ENUM) as AiProviderName[];

export function toProviderEnum(name: AiProviderName): AiProviderId {
  return TO_ENUM[name];
}

export function toProviderName(id: AiProviderId): AiProviderName {
  return AI_PROVIDER_NAMES.find((name) => TO_ENUM[name] === id)!;
}
