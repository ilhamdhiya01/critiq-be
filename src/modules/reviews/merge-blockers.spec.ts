import {
  PullRequestState,
  ReviewDecision,
  ScanStatus,
} from '../../generated/prisma/enums';
import { MergeBlockersInput, mergeBlockers } from './merge-blockers';

const { APPROVE, REQUEST_CHANGES } = ReviewDecision;

const input = (
  overrides: Partial<MergeBlockersInput> = {},
): MergeBlockersInput => ({
  state: PullRequestState.OPEN,
  headSha: 'abc123',
  latestScan: { status: ScanStatus.DONE, headSha: 'abc123', criticalCount: 0 },
  reviewsOnHead: [{ reviewerId: 'u_1', decision: APPROVE }],
  ...overrides,
});

describe('mergeBlockers', () => {
  it('lets an approved, scanned, clean PR merge', () => {
    expect(mergeBlockers(input())).toEqual([]);
  });

  it('blocks a PR that is not open, and nothing else matters', () => {
    expect(
      mergeBlockers(
        input({ state: PullRequestState.MERGED, reviewsOnHead: [] }),
      ),
    ).toEqual(['pull_not_open']);
  });

  it('needs an approval on the head', () => {
    expect(mergeBlockers(input({ reviewsOnHead: [] }))).toEqual([
      'approval_required',
    ]);
  });

  // Newest first: each reviewer counts with their latest decision.
  it('follows a reviewer who changed their mind', () => {
    expect(
      mergeBlockers(
        input({
          reviewsOnHead: [
            { reviewerId: 'u_1', decision: REQUEST_CHANGES },
            { reviewerId: 'u_1', decision: APPROVE },
          ],
        }),
      ),
    ).toEqual(['approval_required', 'changes_requested']);
    expect(
      mergeBlockers(
        input({
          reviewsOnHead: [
            { reviewerId: 'u_1', decision: APPROVE },
            { reviewerId: 'u_1', decision: REQUEST_CHANGES },
          ],
        }),
      ),
    ).toEqual([]);
  });

  // One approval does not outvote another reviewer's change request.
  it('blocks while any reviewer requests changes', () => {
    expect(
      mergeBlockers(
        input({
          reviewsOnHead: [
            { reviewerId: 'u_2', decision: REQUEST_CHANGES },
            { reviewerId: 'u_1', decision: APPROVE },
          ],
        }),
      ),
    ).toEqual(['changes_requested']);
  });

  it.each([
    [null],
    [{ status: ScanStatus.FAILED, headSha: 'abc123', criticalCount: 0 }],
    [{ status: ScanStatus.DONE, headSha: 'old', criticalCount: 0 }],
  ])('needs a finished scan of the head: %j', (latestScan) => {
    expect(mergeBlockers(input({ latestScan }))).toEqual(['scan_required']);
  });

  it('blocks on active critical findings', () => {
    expect(
      mergeBlockers(
        input({
          latestScan: {
            status: ScanStatus.DONE,
            headSha: 'abc123',
            criticalCount: 2,
          },
        }),
      ),
    ).toEqual(['critical_findings']);
  });
});
