import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

class InlinePositionDto {
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  path!: string;

  @IsInt()
  @Min(1)
  line!: number;

  // new: an added or unchanged line (new-side number); old: a removed one.
  @IsIn(['new', 'old'])
  side!: 'new' | 'old';

  // Must be the PR's current head (409 head_changed otherwise).
  @IsString()
  headSha!: string;
}

// One of: a general comment ({ body }), a new inline thread ({ body,
// inline }), or a reply ({ body, parentId }) — a reply takes its thread's
// place, so `inline` alongside `parentId` is refused (422).
export class CreateCommentDto {
  @IsString()
  @MinLength(1)
  @MaxLength(10000)
  body!: string;

  @IsOptional()
  @IsString()
  parentId?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => InlinePositionDto)
  inline?: InlinePositionDto;
}
