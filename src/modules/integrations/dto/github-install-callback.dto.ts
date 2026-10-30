import {
  IsIn,
  IsNotEmpty,
  IsNumberString,
  IsOptional,
  IsString,
  ValidateIf,
} from 'class-validator';

// Field names mirror GitHub's actual query string wire format exactly
// (snake_case), matching this module's established convention
// (see connect-gitlab.dto.ts).
export class GithubInstallCallbackDto {
  // Absent on setup_action=request: a non-owner only requested the install
  // from the GitHub organization's owner, so nothing is installed yet.
  @ValidateIf(
    (dto: GithubInstallCallbackDto) =>
      dto.setup_action !== 'request' || dto.installation_id !== undefined,
  )
  @IsNumberString()
  installation_id?: string;

  @IsIn(['install', 'update', 'request'])
  setup_action!: 'install' | 'update' | 'request';

  // Present when GitHub is completing a flow Critiq itself started (via
  // installations/new?state=...). Absent when the admin instead reaches
  // this same Setup URL from GitHub's own UI — e.g. changing an existing
  // installation's granted repos from github.com/settings/installations
  // ("Redirect on update" sends setup_action=update here too, but GitHub
  // never had a `state` to echo back in that case, since no Critiq-issued
  // installations/new link was ever visited for that trip).
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  state?: string;
}

// GitHub's OAuth web flow redirect after the installation ownership check.
// `error` (e.g. access_denied) instead of `code` when the user declines.
export class GithubAuthorizeCallbackDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  code?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  state?: string;

  @IsOptional()
  @IsString()
  error?: string;
}
