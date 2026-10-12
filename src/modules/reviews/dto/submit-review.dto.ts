import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class SubmitReviewDto {
  @IsIn(['approve', 'request_changes'])
  decision!: 'approve' | 'request_changes';

  // The head commit the reviewer was looking at; must still be the PR's
  // head (409 head_changed otherwise).
  @IsString()
  headSha!: string;

  // Optional for approve; required for request_changes (checked in the
  // service, 422 body_required — GitHub refuses a change request without).
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  body?: string;

  // Require both: approve is refused until this is explicitly true.
  @IsOptional()
  @IsBoolean()
  manualConfirmation?: boolean;
}
