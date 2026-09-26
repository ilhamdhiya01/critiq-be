import {
  Provider,
  PullRequestState,
  ReviewPolicy,
} from '../../../generated/prisma/enums';

// Same shape as PullRequestListItemDto plus repository identifiers — used
// only by the org-wide list (GET orgs/:orgId/pulls), where results span
// multiple repos and the FE needs to know which repo each PR belongs to
// without a separate lookup per row.
export class PullRequestOrgListItemDto {
  id!: string;
  repositoryId!: string;
  repositoryPath!: string;
  provider!: Provider;
  externalId!: string;
  title!: string;
  authorUsername!: string | null;
  sourceBranch!: string;
  targetBranch!: string;
  state!: PullRequestState;
  criticalCount!: number;
  effectivePolicy!: ReviewPolicy;
  createdAt!: Date;
  updatedAt!: Date;

  constructor(partial: {
    id: string;
    repositoryId: string;
    repositoryPath: string;
    provider: Provider;
    externalId: string;
    title: string;
    authorUsername: string | null;
    sourceBranch: string;
    targetBranch: string;
    state: PullRequestState;
    criticalCount: number;
    effectivePolicy: ReviewPolicy;
    createdAt: Date;
    updatedAt: Date;
  }) {
    Object.assign(this, partial);
  }
}
