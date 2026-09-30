import {
  AiRiskLevel,
  AiScanStatus,
  FindingCategory,
} from '../../../generated/prisma/enums';

// AI review fields shared by every scan shape in the API (latestScan in PR
// lists/detail, scan history, scan status). Statuses and categories go out
// lowercase, as in the PRD's examples — the same convention as
// suppressedReason; the Prisma enums stay uppercase.
export type ApiAiStatus = Lowercase<AiScanStatus>;
export type ApiFindingCategory = Lowercase<FindingCategory>;

export function toApiAiStatus(status: AiScanStatus | null): ApiAiStatus | null {
  return status ? (status.toLowerCase() as ApiAiStatus) : null;
}

export function toApiCategory(
  category: FindingCategory | null,
): ApiFindingCategory | null {
  return category ? (category.toLowerCase() as ApiFindingCategory) : null;
}

export const AI_SCAN_FIELDS_SELECT = {
  aiStatus: true,
  aiErrorCode: true,
  aiProvider: true,
  aiModel: true,
  aiCached: true,
  majorCount: true,
  minorCount: true,
  aiFindingsDropped: true,
  aiReportedRiskLevel: true,
} as const;

export interface AiScanFieldsRow {
  aiStatus: AiScanStatus | null;
  aiErrorCode: string | null;
  aiProvider: string | null;
  aiModel: string | null;
  aiCached: boolean;
  majorCount: number;
  minorCount: number;
  aiFindingsDropped: number;
  aiReportedRiskLevel: AiRiskLevel | null;
}

export interface ApiAiScanFields {
  // null = the AI step never evaluated this scan (e.g. static FAILED, or
  // scanned before v1.5.1).
  aiStatus: ApiAiStatus | null;
  aiErrorCode: string | null;
  aiProvider: string | null;
  aiModel: string | null;
  aiCached: boolean;
  // AI-only; criticalCount already includes AI criticals.
  majorCount: number;
  minorCount: number;
  // AI findings below the confidence gate — counted, not stored.
  aiFindingsDropped: number;
  // The model's own risk_level; the PR's risk (summary) is computed from
  // the active findings.
  aiReportedRiskLevel: Lowercase<AiRiskLevel> | null;
}

export function toApiAiScanFields(row: AiScanFieldsRow): ApiAiScanFields {
  return {
    aiStatus: toApiAiStatus(row.aiStatus),
    aiErrorCode: row.aiErrorCode,
    aiProvider: row.aiProvider,
    aiModel: row.aiModel,
    aiCached: row.aiCached,
    majorCount: row.majorCount,
    minorCount: row.minorCount,
    aiFindingsDropped: row.aiFindingsDropped,
    aiReportedRiskLevel: row.aiReportedRiskLevel
      ? (row.aiReportedRiskLevel.toLowerCase() as Lowercase<AiRiskLevel>)
      : null,
  };
}
