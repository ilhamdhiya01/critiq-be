import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class BranchListQueryDto {
  // Server-side filter. Without it the list is only the first page (the
  // 50 most recently updated on GitLab), so a branch outside it is found by
  // searching, not by scrolling. Blank counts as absent.
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() || undefined : value,
  )
  @IsString()
  @MaxLength(100)
  search?: string;
}
