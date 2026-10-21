import { AiScanStatus } from '../../generated/prisma/enums';
import { rescanBlocker } from './scan-in-flight';

describe('rescanBlocker', () => {
  it.each([
    // An unfinished static scan wins, whatever the AI step says.
    [true, AiScanStatus.RUNNING, 'scan_in_progress'],
    [true, null, 'scan_in_progress'],
    // The static scan is DONE but its AI review is not.
    [false, AiScanStatus.QUEUED, 'ai_in_progress'],
    [false, AiScanStatus.RUNNING, 'ai_in_progress'],
    // Finished, failed or never run: a rescan may start.
    [false, AiScanStatus.DONE, null],
    [false, AiScanStatus.CACHED, null],
    [false, AiScanStatus.FAILED, null],
    [false, AiScanStatus.SKIPPED_MANUAL_MODE, null],
    [false, AiScanStatus.BUDGET_EXCEEDED, null],
    [false, null, null],
    // A PR that has never finished a scan has no latest scan.
    [false, undefined, null],
  ])(
    'static in flight %p, latest AI %p → %p',
    (staticInFlight, latestAiStatus, blocker) => {
      expect(rescanBlocker({ staticInFlight, latestAiStatus })).toBe(blocker);
    },
  );
});
