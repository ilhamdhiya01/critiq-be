import { IsIn } from 'class-validator';

// `returnTo` is a closed enum, never a raw URL — accepting an arbitrary
// return URL here would be an open-redirect vector, since the callback
// that later reads this back is unauthenticated (GitHub's server calls it,
// not the admin's browser).
export class GithubInstallIntentDto {
  @IsIn(['setup', 'settings'])
  returnTo!: 'setup' | 'settings';
}
