import { IsIn, IsNotEmpty, IsNumberString, IsString } from 'class-validator';

// Field names mirror GitHub's actual query string wire format exactly
// (snake_case), matching this module's established convention
// (see connect-gitlab.dto.ts).
export class GithubInstallCallbackDto {
  @IsNumberString()
  installation_id!: string;

  @IsIn(['install', 'update', 'request'])
  setup_action!: 'install' | 'update' | 'request';

  @IsString()
  @IsNotEmpty()
  state!: string;
}
