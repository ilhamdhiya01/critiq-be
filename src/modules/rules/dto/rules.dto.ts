import { IsBoolean, IsIn } from 'class-validator';
import { ALL_RULE_TIERS } from '../../../queue/rules/rule-tiers';
import {
  type ApiRuleTier,
  toApiRuleTier,
} from '../../scans/dto/ai-scan-fields';

// How a tier is checked: by static rules, by the AI review, or both.
export type RuleTierEngine = 'static' | 'ai' | 'static+ai';

export interface RuleTierDto {
  id: ApiRuleTier;
  enabled: boolean;
  engine: RuleTierEngine;
  // Only the AI review checks this tier: with no AI review on a PR (Manual
  // only, no provider, too large) it is not checked at all.
  requiresAi: boolean;
  staticRules: string[];
  aiCategories: string[];
}

export interface RulesDto {
  tiers: RuleTierDto[];
  enabledCount: number;
  totalCount: number;
  updatedAt: string | null;
  updatedBy: string | null;
}

// Tier ids go out and come in lowercase, like every other enum in the API.
export class UpdateRuleTierDto {
  @IsIn(ALL_RULE_TIERS.map(toApiRuleTier))
  tier!: ApiRuleTier;

  @IsBoolean()
  enabled!: boolean;
}
