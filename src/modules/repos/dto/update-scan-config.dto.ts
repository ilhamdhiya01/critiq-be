import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import {
  DEFAULT_POLICY_VALUES,
  type DefaultPolicyWireValue,
} from './create-repos.dto';

export class BranchPolicyDto {
  @IsString()
  branch!: string;

  @IsIn(DEFAULT_POLICY_VALUES)
  policy!: DefaultPolicyWireValue;
}

// Empty-array rejection is handled in ReposService (422 empty_scope, a
// specific error code the wizard/settings UI branches on) rather than here
// — class-validator's ArrayNotEmpty would only produce a generic shape
// error, not the domain-specific code PRD v1.4.2 §12.4 requires.
export class UpdateScanConfigDto {
  @IsArray()
  @IsString({ each: true })
  branches!: string[];

  // Optional and partial: a branch left out keeps its policy, a new one
  // takes the default branch's. Branch-level rules (in scope, no
  // duplicates) live in ReposService for the same reason as empty_scope.
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BranchPolicyDto)
  policies?: BranchPolicyDto[];
}
