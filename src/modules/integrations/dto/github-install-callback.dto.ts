import {
  IsIn,
  IsNotEmpty,
  IsNumberString,
  IsOptional,
  IsString,
} from 'class-validator';

// Field names mirror GitHub's actual query string wire format exactly
// (snake_case), matching this module's established convention
// (see connect-gitlab.dto.ts).
export class GithubInstallCallbackDto {
  @IsNumberString()
  installation_id!: string;

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
