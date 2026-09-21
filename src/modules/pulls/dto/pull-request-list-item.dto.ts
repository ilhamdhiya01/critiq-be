import {
  Provider,
  PullRequestState,
  ReviewPolicy,
} from '../../../generated/prisma/enums';

export class PullRequestListItemDto {
  id!: string;
  provider!: Provider;
  externalId!: string;
  title!: string;
  authorUsername!: string | null;
  sourceBranch!: string;
  targetBranch!: string;
  state!: PullRequestState;
  effectivePolicy!: ReviewPolicy;
  createdAt!: Date;
  updatedAt!: Date;

  constructor(partial: {
    id: string;
    provider: Provider;
    externalId: string;
    title: string;
    authorUsername: string | null;
    sourceBranch: string;
    targetBranch: string;
    state: PullRequestState;
    effectivePolicy: ReviewPolicy;
    createdAt: Date;
    updatedAt: Date;
  }) {
    Object.assign(this, partial);
  }
}
