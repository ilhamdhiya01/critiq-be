export class GitlabConnectionResponseDto {
  id: string;
  instanceUrl: string;
  connectedAt: Date;

  constructor(partial: { id: string; instanceUrl: string; connectedAt: Date }) {
    this.id = partial.id;
    this.instanceUrl = partial.instanceUrl;
    this.connectedAt = partial.connectedAt;
  }
}
