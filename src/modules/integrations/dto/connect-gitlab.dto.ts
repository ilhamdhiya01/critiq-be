import { IsNotEmpty, IsString, IsUrl } from 'class-validator';

export class ConnectGitlabDto {
  @IsUrl({ require_tld: false })
  instanceUrl!: string;

  @IsString()
  @IsNotEmpty()
  personalAccessToken!: string;
}
