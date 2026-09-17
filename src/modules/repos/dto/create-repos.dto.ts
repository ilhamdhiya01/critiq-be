import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { ReviewPolicy } from '../../../generated/prisma/enums';

// `id` matches the numeric id shape returned by GitlabCandidateDto/
// GithubCandidateDto (both `number`) — this is the same candidate id the
// wizard picker already displayed, round-tripped back on submit.
class CreateReposProjectDto {
  @IsInt()
  id!: number;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  monitoredBranches?: string[];
}

export class CreateReposDto {
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => CreateReposProjectDto)
  projects!: CreateReposProjectDto[];

  @IsIn(Object.values(ReviewPolicy))
  defaultPolicy!: ReviewPolicy;
}
