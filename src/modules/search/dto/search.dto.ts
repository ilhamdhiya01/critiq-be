import { Transform, Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export const DEFAULT_SEARCH_LIMIT = 5;

export class SearchQueryDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  q!: string;

  // Per group.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10)
  limit?: number;
}

export interface SearchRepositoryDto {
  id: string;
  path: string;
  language: string | null;
  // Active criticals in the latest scan of the repo's open PRs.
  openCriticalCount: number;
}

export interface SearchPullDto {
  id: string;
  repoId: string;
  repoPath: string;
  number: string;
  title: string;
  state: 'open' | 'closed' | 'merged';
  updatedAt: Date;
}

export interface SearchRuleDto {
  // A tier is a toggle on the Rules page; a rule is one static check in it.
  kind: 'tier' | 'rule';
  id: string;
  label: string;
  // The API tier id the item belongs to (the Rules page anchor).
  tier: string;
}

export class SearchResultsDto {
  repositories!: SearchRepositoryDto[];
  pulls!: SearchPullDto[];
  rules!: SearchRuleDto[];

  constructor(partial: SearchResultsDto) {
    Object.assign(this, partial);
  }
}
