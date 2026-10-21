import { AiScanStatus, ScanStatus } from '../../generated/prisma/enums';

// A static scan that has not finished.
export const SCAN_IN_FLIGHT: ScanStatus[] = [
  ScanStatus.QUEUED,
  ScanStatus.RUNNING,
];

// An AI review that has not finished. It starts once the static scan is
// DONE, so a scan can be DONE while its AI review is still running.
export const AI_IN_FLIGHT: AiScanStatus[] = [
  AiScanStatus.QUEUED,
  AiScanStatus.RUNNING,
];

export type RescanBlocker = 'scan_in_progress' | 'ai_in_progress';

// Why a manual rescan of a PR must wait, or null when it may start. A rescan
// while the AI review is running starts a second review of the same commit:
// tokens spent on a result nobody sees, and an AI_CONCURRENCY slot shared by
// every organization held meanwhile. `latestAiStatus` is the PR's latest
// scan only, so an older scan left RUNNING by a dead worker never locks it.
export function rescanBlocker(state: {
  staticInFlight: boolean;
  latestAiStatus: AiScanStatus | null | undefined;
}): RescanBlocker | null {
  if (state.staticInFlight) {
    return 'scan_in_progress';
  }
  if (state.latestAiStatus && AI_IN_FLIGHT.includes(state.latestAiStatus)) {
    return 'ai_in_progress';
  }
  return null;
}
