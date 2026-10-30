import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateIf,
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

  // Admin only: merge although critical findings are active. Not
  // @IsOptional: that also lets `null` through unvalidated, and a `null`
  // override once skipped the Admin check while still counting as an
  // override. Absent is fine; present must be a real object with a reason.
  @ValidateIf((dto: MergePullDto) => dto.overrideCritical !== undefined)
  @IsObject()
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
