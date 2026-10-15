import { hostname } from 'os';
import type Redis from 'ioredis';

// Each worker process sets its own key every HEARTBEAT_INTERVAL_MS; a key
// that outlives HEARTBEAT_TTL_SECONDS without a refresh is a dead worker.
// Read by GET /health in the app, which cannot see the worker's
// /tmp/worker-alive file (that one is for the worker's docker healthcheck).
export const WORKER_HEARTBEAT_PREFIX = 'worker:heartbeat:';
export const HEARTBEAT_INTERVAL_MS = 10_000;
export const HEARTBEAT_TTL_SECONDS = 30;

// Host + pid: one key per process, also when several run on one machine.
export function workerHeartbeatKey(): string {
  return `${WORKER_HEARTBEAT_PREFIX}${hostname()}:${process.pid}`;
}

// The value is the time of the beat, so GET /health can report its age.
export async function beat(redis: Redis, key: string): Promise<void> {
  await redis.set(key, new Date().toISOString(), 'EX', HEARTBEAT_TTL_SECONDS);
}
