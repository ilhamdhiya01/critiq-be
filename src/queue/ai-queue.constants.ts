// The `ai` queue (v1.5.1 langkah 2): one job per AI review of a scan. Same
// Redis as the scan queue, processed by the same worker process.
export const AI_QUEUE_NAME = 'ai';

// Ids only — the worker loads the scan, the organization's provider
// settings and the credential from the DB when it runs.
export interface AiJobPayload {
  scanId: string;
  organizationId: string;
  pullId: string;
}

// `ai-{scanId}-{requestedAt}`, not the spec's `ai:{scanId}`: BullMQ 6
// rejects custom ids containing ':', and a bare `ai-{scanId}` would collide
// with the previous run still retained in the completed set when a scan is
// regenerated — BullMQ silently drops an add() whose id exists. At most one
// run per scan is guaranteed by Scan.aiStatus (QUEUED/RUNNING → 409), not
// by the job id.
export function buildAiJobId(scanId: string, requestedAt: number): string {
  return `ai-${scanId}-${requestedAt}`;
}

export const AI_JOB_ATTEMPTS = 4; // 1 + 3 retries
const AI_RETRY_DELAYS_MS = [10_000, 30_000, 90_000];

// Worker-level custom backoff for jobs added with `backoff: { type: 'ai' }`.
export function aiBackoff(attemptsMade: number): number {
  return (
    AI_RETRY_DELAYS_MS[attemptsMade - 1] ??
    AI_RETRY_DELAYS_MS[AI_RETRY_DELAYS_MS.length - 1]
  );
}
