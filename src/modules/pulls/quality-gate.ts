import {
  AiScanStatus,
  CiState,
  RuleTier,
  ScanStatus,
} from '../../generated/prisma/enums';
import {
  ApiRuleTier,
  AiScanFieldsRow,
  toApiAiScanFields,
} from '../scans/dto/ai-scan-fields';

// What the code host reports for the PR's head commit, all checks together.
// NONE: nothing reported — the repository has no CI, or its results are not
// delivered to Critiq (GitHub App without the Checks permission).
export type CiAggregate = 'SUCCESS' | 'FAILURE' | 'PENDING' | 'NONE';

export function aggregateCi(states: CiState[]): CiAggregate {
  if (states.length === 0) {
    return 'NONE';
  }
  if (states.includes(CiState.FAILURE)) {
    return 'FAILURE';
  }
  return states.includes(CiState.PENDING) ? 'PENDING' : 'SUCCESS';
}

export type QualityGateReason =
  | 'not_scanned'
  | 'scan_failed'
  | 'scan_running'
  | 'critical_findings'
  | 'ci_failed'
  | 'ci_running'
  | 'ci_not_detected'
  | 'stale_scan';

export interface QualityGateDto {
  status: 'passed' | 'failed' | 'pending';
  // Every reason that applies; `ci_not_detected` alone does not block.
  reasons: QualityGateReason[];
  ci: Lowercase<CiAggregate>;
  // Enabled tiers nothing looked at — shown, never blocking (a Manual-only
  // branch would otherwise never pass).
  uncheckedTiers: ApiRuleTier[];
}

export interface QualityGateInput {
  pullHeadSha: string | null;
  // The PR's latest terminal scan.
  scan:
    | (AiScanFieldsRow & {
        status: ScanStatus;
        headSha: string;
        criticalCount: number;
      })
    | null;
  // A scan is queued or running for the PR right now.
  scanInFlight: boolean;
  ci: CiAggregate;
}

const AI_IN_FLIGHT: AiScanStatus[] = [
  AiScanStatus.QUEUED,
  AiScanStatus.RUNNING,
];

// PRD §6: PASSED = no active Critical on the enabled rules AND CI green —
// both checked explicitly. CI only counts when the CI tier is on.
export function qualityGate(input: QualityGateInput): QualityGateDto {
  const { scan } = input;
  const reasons: QualityGateReason[] = [];
  let failed = false;
  let pending = false;

  if (!scan) {
    reasons.push('not_scanned');
    pending = true;
  } else if (scan.status === ScanStatus.FAILED) {
    reasons.push('scan_failed');
    failed = true;
  } else {
    if (scan.criticalCount > 0) {
      reasons.push('critical_findings');
      failed = true;
    }
    if (input.pullHeadSha !== null && scan.headSha !== input.pullHeadSha) {
      reasons.push('stale_scan');
      pending = true;
    }
  }
  if (
    input.scanInFlight ||
    (scan?.aiStatus != null && AI_IN_FLIGHT.includes(scan.aiStatus))
  ) {
    reasons.push('scan_running');
    pending = true;
  }

  const ciOn = scan ? scan.ruleTiers.includes(RuleTier.CI) : true;
  if (ciOn) {
    if (input.ci === 'FAILURE') {
      reasons.push('ci_failed');
      failed = true;
    } else if (input.ci === 'PENDING') {
      reasons.push('ci_running');
      pending = true;
    } else if (input.ci === 'NONE') {
      reasons.push('ci_not_detected');
    }
  }

  return {
    status: failed ? 'failed' : pending ? 'pending' : 'passed',
    reasons,
    ci: input.ci.toLowerCase() as Lowercase<CiAggregate>,
    uncheckedTiers: scan ? toApiAiScanFields(scan).uncheckedTiers : [],
  };
}
