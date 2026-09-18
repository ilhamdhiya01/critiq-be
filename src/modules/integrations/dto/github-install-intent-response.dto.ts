export class GithubInstallIntentResponseDto {
  installUrl!: string;

  constructor(partial: { installUrl: string }) {
    Object.assign(this, partial);
  }
}
