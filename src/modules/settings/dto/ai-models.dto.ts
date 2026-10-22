import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { AI_PROVIDER_NAMES } from '../../ai/ai-models.constants';
import type { AiProviderName } from '../../ai/ai-provider.interface';

// GET …/settings/ai/models?provider= — with the stored key.
export class ListAiModelsQueryDto {
  @IsIn(AI_PROVIDER_NAMES)
  provider!: AiProviderName;
}

// POST …/settings/ai/models — with a key/base URL typed in the form, before
// saving. Nothing here is persisted.
export class PreviewAiModelsDto {
  @IsIn(AI_PROVIDER_NAMES)
  provider!: AiProviderName;

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
