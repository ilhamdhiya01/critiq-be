import {
  PullRequestState,
  ReviewDecision,
  ScanStatus,
} from '../../generated/prisma/enums';

// Why a PR cannot be merged from Critiq yet, in the order the FE lists them.
export type MergeBlocker =
  | 'pull_not_open'
  | 'approval_required'
  | 'changes_requested'
  | 'scan_required'
  | 'critical_findings';

export interface MergeBlockersInput {
  state: PullRequestState;
  headSha: string | null;
  latestScan: {
    status: ScanStatus;
    headSha: string;
    criticalCount: number;
  } | null;
  // Reviews of the current head only, newest first.
  reviewsOnHead: { reviewerId: string | null; decision: ReviewDecision }[];
}

// One rule for the merge endpoint and the PR detail, so the button the FE
// disables and the request the BE refuses never disagree. Each reviewer
// counts with their latest decision on the head; reviews of an older commit
// count for nothing. Critical findings block too — the Admin override is
// the endpoint's business, not this function's.
export function mergeBlockers(input: MergeBlockersInput): MergeBlocker[] {
  if (input.state !== PullRequestState.OPEN) {
    return ['pull_not_open'];
  }
  const latestByReviewer = new Map<string, ReviewDecision>();
  input.reviewsOnHead.forEach((review, index) => {
    // A deleted reviewer's review still counts, on its own.
    const key = review.reviewerId ?? `deleted-${index}`;
    if (!latestByReviewer.has(key)) {
      latestByReviewer.set(key, review.decision);
    }
  });
  const decisions = [...latestByReviewer.values()];

  const blockers: MergeBlocker[] = [];
  if (!decisions.includes(ReviewDecision.APPROVE)) {
    blockers.push('approval_required');
  }
  if (decisions.includes(ReviewDecision.REQUEST_CHANGES)) {
    blockers.push('changes_requested');
  }
  const scan = input.latestScan;
  if (
    !scan ||
    scan.status !== ScanStatus.DONE ||
    input.headSha === null ||
    scan.headSha !== input.headSha
  ) {
    blockers.push('scan_required');
  } else if (scan.criticalCount > 0) {
    blockers.push('critical_findings');
  }
  return blockers;
}

// The reviews of the PR's head plus mergeBlockers, for the merge endpoint
// and the PR detail alike.
export async function loadMergeBlockers(
  prisma: {
    pullReview: {
      findMany(args: {
        where: { pullId: string; headSha: string };
        orderBy: { createdAt: 'desc' };
        select: { reviewerId: true; decision: true };
      }): Promise<{ reviewerId: string | null; decision: ReviewDecision }[]>;
    };
  },
  pull: {
    id: string;
    state: PullRequestState;
    headSha: string | null;
    latestScan: MergeBlockersInput['latestScan'];
  },
): Promise<MergeBlocker[]> {
  const reviewsOnHead = pull.headSha
    ? await prisma.pullReview.findMany({
        where: { pullId: pull.id, headSha: pull.headSha },
        orderBy: { createdAt: 'desc' },
        select: { reviewerId: true, decision: true },
      })
    : [];
  return mergeBlockers({
    state: pull.state,
    headSha: pull.headSha,
    latestScan: pull.latestScan,
    reviewsOnHead,
  });
}
