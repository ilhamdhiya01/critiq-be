import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import type { FindingSource } from '../../../generated/prisma/enums';

export const DEFAULT_WEEKS = 8;

export class InsightsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(4)
  @Max(26)
  weeks?: number;
}

export interface InsightsWeekDto {
  // Monday of the ISO week, UTC, YYYY-MM-DD.
  weekStart: string;
  static: number;
  ai: number;
}

export interface InsightsRuleDto {
  ruleId: string;
  label: string;
  source: FindingSource;
  count: number;
}

// Criticals only, never suppressed ones, and each appearance once — see
// CLAUDE.md "Insights" for the definitions.
export class InsightsDto {
  criticalFound!: { last30d: number; previous30d: number };
  // Criticals that stopped appearing in their PR; one per resolution.
  criticalResolved!: { last30d: number; previous30d: number };
  // First detection → no longer in the PR. Null with nothing resolved.
  meanTimeToResolveHours!: {
    last30d: number | null;
    previous30d: number | null;
  };
  // Oldest first; weeks without findings are 0.
  weekly!: InsightsWeekDto[];
  // Up to 5, most frequent first, over the last 30 days.
  topRules!: InsightsRuleDto[];

  constructor(partial: InsightsDto) {
    Object.assign(this, partial);
  }
}
