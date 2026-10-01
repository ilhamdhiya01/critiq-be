import { IsBoolean, IsOptional } from 'class-validator';
import type { ApiAiStatus } from '../../scans/dto/ai-scan-fields';

export class RegenerateSummaryDto {
  // Skip the AI cache and call the provider again.
  @IsOptional()
  @IsBoolean()
  force?: boolean;
}

// GET …/pulls/:id/summary — the AI review of the PR's latest scan.
export class PullSummaryDto {
  scanId!: string | null;
  aiStatus!: ApiAiStatus | null;
  summaryMd!: string | null;
  // Computed from the PR's active findings (static and AI).
  riskLevel!: 'low' | 'medium' | 'high' | null;
  // The model's own rating, before Critiq filtered its findings.
  reportedRiskLevel!: 'low' | 'medium' | 'high' | null;
  // The model left the summary or the findings out even after a retry;
  // the review was kept with that part empty.
  partial!: boolean;
  provider!: string | null;
  model!: string | null;
  generatedAt!: Date | null;
  cached!: boolean;
  filesOmitted!: string[];
  tokens!: { in: number; out: number } | null;
  // Why there is no summary, with what to do about it.
  error!: { code: string; hint: string } | null;

  constructor(partial: PullSummaryDto) {
    Object.assign(this, partial);
  }
}
