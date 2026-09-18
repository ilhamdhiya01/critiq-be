// `missing` (branches in scope that no longer exist at the provider) and
// `missingCheckStatus` are a deliberately honest pair while there's no
// Redis cache yet (Fase 4): computing `missing` accurately would mean a
// live provider call on every GET, which risks rate limits for an endpoint
// any org member can hit. So this always returns `missing: []` +
// `missingCheckStatus: 'not_available'` for now — an empty array that does
// NOT mean "nothing is missing", flagged explicitly rather than silently
// implying accuracy. GET .../repos/:id/branches remains the live-checked
// endpoint for when that's actually needed.
export class RepoScanConfigResponseDto {
  defaultBranch!: string;
  branches!: string[];
  missing!: string[];
  missingCheckStatus!: 'not_available';
  defaultBranchChangedAt!: Date | null;

  constructor(partial: {
    defaultBranch: string;
    branches: string[];
    defaultBranchChangedAt: Date | null;
  }) {
    Object.assign(this, {
      ...partial,
      missing: [],
      missingCheckStatus: 'not_available',
    });
  }
}
