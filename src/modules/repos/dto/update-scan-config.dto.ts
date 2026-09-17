import { IsArray, IsString } from 'class-validator';

// Empty-array rejection is handled in ReposService (422 empty_scope, a
// specific error code the wizard/settings UI branches on) rather than here
// — class-validator's ArrayNotEmpty would only produce a generic shape
// error, not the domain-specific code PRD v1.4.2 §12.4 requires.
export class UpdateScanConfigDto {
  @IsArray()
  @IsString({ each: true })
  branches!: string[];
}
