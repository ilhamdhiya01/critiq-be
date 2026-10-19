import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export const ACTIVITY_PAGE_SIZE = 20;

export class ActivityQueryDto {
  @IsOptional()
  @IsIn(['approve', 'request_changes'])
  decision?: 'approve' | 'request_changes';

  @IsOptional()
  @IsIn(['manual', 'ai_assisted'])
  mode?: 'manual' | 'ai_assisted';

  // Opaque: the nextCursor of the previous page.
  @IsOptional()
  @IsString()
  @MaxLength(200)
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}
