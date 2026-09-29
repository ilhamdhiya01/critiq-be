import {
  DiffMode,
  FindingStatus,
  FullReason,
} from '../../../generated/prisma/enums';

// Scan lifecycle fields (v1.5.1 langkah 3), lowercase on the wire like the
// other enum-valued fields added in v1.5.
export type ApiDiffMode = Lowercase<DiffMode>;
export type ApiFullReason = Lowercase<FullReason>;
export type ApiFindingStatus = Lowercase<FindingStatus>;

export function toApiFindingStatus(status: FindingStatus): ApiFindingStatus {
  return status.toLowerCase() as ApiFindingStatus;
}

export const LIFECYCLE_FIELDS_SELECT = {
  diffMode: true,
  fullReason: true,
  baseScanId: true,
  prevHeadSha: true,
  newCount: true,
  persistedCount: true,
  reopenedCount: true,
  resolvedCount: true,
} as const;

export interface LifecycleFieldsRow {
  diffMode: DiffMode;
  fullReason: FullReason | null;
  baseScanId: string | null;
  prevHeadSha: string | null;
  newCount: number;
  persistedCount: number;
  reopenedCount: number;
  resolvedCount: number;
}

export interface ApiLifecycleFields {
  // full = the whole PR diff; incremental = only what changed since
  // baseScanId (prevHeadSha → headSha).
  diffMode: ApiDiffMode;
  fullReason: ApiFullReason | null;
  baseScanId: string | null;
  prevHeadSha: string | null;
  newCount: number;
  persistedCount: number;
  reopenedCount: number;
  resolvedCount: number;
}

export function toApiLifecycleFields(
  row: LifecycleFieldsRow,
): ApiLifecycleFields {
  return {
    diffMode: row.diffMode.toLowerCase() as ApiDiffMode,
    fullReason: row.fullReason
      ? (row.fullReason.toLowerCase() as ApiFullReason)
      : null,
    baseScanId: row.baseScanId,
    prevHeadSha: row.prevHeadSha,
    newCount: row.newCount,
    persistedCount: row.persistedCount,
    reopenedCount: row.reopenedCount,
    resolvedCount: row.resolvedCount,
  };
}
