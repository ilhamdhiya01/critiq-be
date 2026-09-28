import { IsIn, IsOptional } from 'class-validator';

export class ListFindingsQueryDto {
  // Kept as the literal strings rather than transformed to a boolean:
  // class-transformer turns any non-empty string — "false" included — into
  // true, which is exactly the value this flag exists to express. Anything
  // but the two literals is a 400, not a silent default.
  @IsOptional()
  @IsIn(['true', 'false'])
  includeSuppressed?: 'true' | 'false';
}
