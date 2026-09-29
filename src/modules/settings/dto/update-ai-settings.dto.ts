import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

// Every field optional (partial update). For apiKey the three states mean
// different things, so they are kept distinct end to end:
//   a string  → store it (encrypted) for the provider being configured
//   ""        → delete that provider's key
//   null / absent → keep whatever is stored
export class UpdateAiSettingsDto {
  // 'google' is accepted by validation on purpose so the service can answer
  // 422 provider_unavailable instead of a generic 400.
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

  @IsOptional()
  @Matches(/^[a-z]{2}(-[A-Z]{2})?$/)
  locale?: string;

  @IsOptional()
  @IsInt()
  @Min(10_000)
  @Max(50_000_000)
  dailyTokenBudget?: number;

  @IsOptional()
  @IsBoolean()
  consent?: boolean;
}
