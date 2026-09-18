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

// Wire values match GithubInstallIntentDto's convention: lowercase strings
// on the wire, mapped to the Prisma ReviewPolicy enum in the service layer
// — not the Prisma enum's own SCREAMING_SNAKE_CASE values directly.
export const DEFAULT_POLICY_VALUES = [
  'manual_only',
  'allow_ai',
  'require_both',
] as const;
export type DefaultPolicyWireValue = (typeof DEFAULT_POLICY_VALUES)[number];

// `id` is the same candidate id GitlabCandidateDto/GithubCandidateDto
// already returned as a `number` — but the FE round-trips it as a numeric
// string on submit (likely to avoid precision concerns with large GitHub
// ids in JS), so @Type(() => Number) coerces it before @IsInt() validates
// it. The global ValidationPipe runs with `transform: true`
// (common.module.ts), which is what makes this coercion actually happen at
// the controller boundary rather than silently failing validation.
class CreateReposProjectDto {
  @Type(() => Number)
  @IsInt()
  id!: number;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  monitoredBranches?: string[];
}

// `source` is required at the top level, not inferred per project — D4
// (wizard source follows login provider) only constrains onboarding UX, it
// doesn't guarantee an org only ever has one integration. An org that
// connected GitHub first and later added GitLab (Settings > Integrations,
// outside the onboarding wizard) has both active at once, so guessing the
// provider from "whichever integration exists" is genuinely ambiguous —
// the FE already knows which candidates list (source) this submission came
// from and sends it explicitly instead.
export class CreateReposDto {
  @IsIn(['github', 'gitlab'])
  source!: 'github' | 'gitlab';

  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => CreateReposProjectDto)
  projects!: CreateReposProjectDto[];

  @IsIn(DEFAULT_POLICY_VALUES)
  defaultPolicy!: DefaultPolicyWireValue;
}
