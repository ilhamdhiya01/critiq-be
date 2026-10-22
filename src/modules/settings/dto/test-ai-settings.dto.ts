import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { AI_PROVIDER_NAMES } from '../../ai/ai-models.constants';
import type { AiProviderName } from '../../ai/ai-provider.interface';

// Optional override to test a configuration before saving it. Nothing here
// is persisted — including the key.
export class TestAiSettingsDto {
  @IsOptional()
  @IsIn(AI_PROVIDER_NAMES)
  provider?: AiProviderName;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  model?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  baseUrl?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  apiKey?: string | null;
}
