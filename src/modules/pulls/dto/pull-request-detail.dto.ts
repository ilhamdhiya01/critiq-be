import {
  Provider,
  PullRequestState,
  ReviewPolicy,
} from '../../../generated/prisma/enums';

export class PullRequestDetailDto {
  id!: string;
  repositoryId!: string;
  provider!: Provider;
  externalId!: string;
  title!: string;
  repositoryPath!: string;
  authorUsername!: string | null;
  sourceBranch!: string;
  targetBranch!: string;
  headSha!: string | null;
  state!: PullRequestState;
  effectivePolicy!: ReviewPolicy;
  createdAt!: Date;
  updatedAt!: Date;

  constructor(partial: {
    id: string;
    repositoryId: string;
    provider: Provider;
    externalId: string;
    title: string;
    repositoryPath: string;
    authorUsername: string | null;
    sourceBranch: string;
    targetBranch: string;
    headSha: string | null;
    state: PullRequestState;
    effectivePolicy: ReviewPolicy;
    createdAt: Date;
    updatedAt: Date;
  }) {
    Object.assign(this, partial);
  }
}
