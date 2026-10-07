import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { AiProviderName } from '../../ai/ai-provider.interface';

// 'google' passes validation so the service can answer 422
// provider_unavailable, as PUT settings/ai does.
const PROVIDERS = [
  'anthropic',
  'openai',
  'openai_compatible',
  'google',
] as const;
type ProviderParam = (typeof PROVIDERS)[number];

// GET …/settings/ai/models?provider= — with the stored key.
export class ListAiModelsQueryDto {
  @IsIn(PROVIDERS)
  provider!: ProviderParam;
}

// POST …/settings/ai/models — with a key/base URL typed in the form, before
// saving. Nothing here is persisted.
export class PreviewAiModelsDto {
  @IsIn(PROVIDERS)
  provider!: ProviderParam;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  apiKey?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  baseUrl?: string | null;
}

export interface AiModelOption {
  id: string;
  label: string;
  contextWindow: number | null;
  // Tested to review well in Critiq (RECOMMENDED_MODELS).
  recommended: boolean;
}

// Both routes. `source: "catalog"` = the provider could not be asked (no key
// yet, key refused, provider down) and `models` is Critiq's built-in list;
// `warning` says why.
export class AiModelsDto {
  provider!: AiProviderName;
  source!: 'live' | 'catalog';
  fetchedAt!: string;
  warning!: { code: string; message: string } | null;
  models!: AiModelOption[];

  constructor(partial: AiModelsDto) {
    Object.assign(this, partial);
  }
}
