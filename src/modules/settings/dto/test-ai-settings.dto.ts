import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

// Optional override to test a configuration before saving it. Nothing here
// is persisted — including the key.
export class TestAiSettingsDto {
  @IsOptional()
  @IsIn(['anthropic', 'openai', 'openai_compatible', 'google'])
  provider?: 'anthropic' | 'openai' | 'openai_compatible' | 'google';

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
