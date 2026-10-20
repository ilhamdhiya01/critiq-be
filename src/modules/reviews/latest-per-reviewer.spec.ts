import { latestPerReviewer } from './latest-per-reviewer';

describe('latestPerReviewer', () => {
  it("keeps each reviewer's newest decision", () => {
    const reviews = [
      { id: 'r3', reviewerId: 'u_b' },
      { id: 'r2', reviewerId: 'u_a' },
      { id: 'r1', reviewerId: 'u_b' },
    ];
    expect(latestPerReviewer(reviews).map((r) => r.id)).toEqual(['r3', 'r2']);
  });

  // A deleted account's reviews cannot be told apart: each stands alone.
  it('keeps every review of deleted reviewers', () => {
    const reviews = [
      { id: 'r2', reviewerId: null },
      { id: 'r1', reviewerId: null },
    ];
    expect(latestPerReviewer(reviews)).toHaveLength(2);
  });
});
