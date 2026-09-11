import { IsNotEmpty, IsString, IsUrl } from 'class-validator';

// Field names match the JSON body wire format from PRD §12.3 exactly
// (`instance_url`, `token`) — this project doesn't have a global
// snake_case<->camelCase remapping convention, so DTOs mirror the wire
// format directly rather than introducing one just for this endpoint.
export class ConnectGitlabDto {
  @IsUrl({ require_tld: false })
  instance_url!: string;

  @IsString()
  @IsNotEmpty()
  token!: string;
}
