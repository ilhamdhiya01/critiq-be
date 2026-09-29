import { IsIn, IsOptional } from 'class-validator';

export class ListFindingsQueryDto {
  // Kept as the literal strings rather than transformed to a boolean:
  // class-transformer turns any non-empty string — "false" included — into
  // true, which is exactly the value this flag exists to express. Anything
  // but the two literals is a 400, not a silent default.
  @IsOptional()
  @IsIn(['true', 'false'])
  includeSuppressed?: 'true' | 'false';

  // active = new + persisted + reopened (default); resolved = closed by
  // this scan's push ("resolved since last push"); all = both.
  @IsOptional()
  @IsIn(['active', 'resolved', 'all'])
  status?: 'active' | 'resolved' | 'all';
}
