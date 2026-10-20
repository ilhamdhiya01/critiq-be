// Each reviewer's latest decision, from reviews ordered newest first. A
// review whose reviewer was deleted stands on its own. Shared by the merge
// blockers and the PR detail's reviewer list, so both count the same way.
export function latestPerReviewer<T extends { reviewerId: string | null }>(
  newestFirst: readonly T[],
): T[] {
  const seen = new Set<string>();
  return newestFirst.filter((review, index) => {
    const key = review.reviewerId ?? `deleted-${index}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
