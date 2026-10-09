import { ScanDto } from './scan.dto';

// One row of a repository's scan history: the scan plus the PR it ran on,
// so the list links to the PR without a request per row. `number` is the
// provider's PR/MR number (PullRequest.externalId).
export class RepositoryScanDto extends ScanDto {
  pull!: { id: string; number: string; title: string };

  constructor(partial: RepositoryScanDto) {
    super(partial);
    Object.assign(this, partial);
  }
}
