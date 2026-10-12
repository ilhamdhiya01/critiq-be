export type HealthCheckState = 'ok' | 'fail';

export interface QueueCountsDto {
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
}

// Only with a valid HEALTH_TOKEN: these are numbers across every
// organization. Null = that source could not be read just now.
export interface HealthDetailsDto {
  queues: { scan: QueueCountsDto | null; ai: QueueCountsDto | null };
  workers: { alive: number; lastBeatAt: string | null };
  ai: { configuredOrgs: number | null };
}

// GET /health.
export class HealthDto {
  status!: 'ok' | 'degraded' | 'down';
  checks!: {
    db: HealthCheckState;
    redis: HealthCheckState;
    // At least one worker beat within the heartbeat TTL.
    worker: HealthCheckState;
  };
  details?: HealthDetailsDto;

  constructor(partial: HealthDto) {
    Object.assign(this, partial);
  }
}
