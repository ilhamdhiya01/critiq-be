import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

class OverrideCriticalDto {
  // Why the Admin merges despite active critical findings — kept in the
  // audit log.
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}

export class MergePullDto {
  // The head the merger was looking at; must still be the PR's head.
  @IsString()
  headSha!: string;

  @IsOptional()
  @IsIn(['merge', 'squash'])
  method?: 'merge' | 'squash';

  @IsOptional()
  @IsBoolean()
  deleteSourceBranch?: boolean;

  // Admin only: merge although critical findings are active.
  @IsOptional()
  @ValidateNested()
  @Type(() => OverrideCriticalDto)
  overrideCritical?: OverrideCriticalDto;
}

export interface MergeResultDto {
  state: 'merged';
  method: 'merge' | 'squash';
  headSha: string;
  mergedAt: Date;
}
