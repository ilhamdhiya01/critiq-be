import * as fs from 'fs';
import { NestFactory } from '@nestjs/core';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';
import type Redis from 'ioredis';
import { Logger } from 'winston';
import { REDIS_CLIENT } from './common/redis/redis.constants';
import {
  beat,
  HEARTBEAT_INTERVAL_MS,
  workerHeartbeatKey,
} from './common/redis/worker-heartbeat';
import { WorkerModule } from './queue/worker.module';

// No HTTP listener — this process only runs BullMQ processors
// (createApplicationContext skips the HTTP adapter entirely). Builds to
// dist/src/worker.js (nest build mirrors src/'s nesting under dist/, same
// as main.ts → dist/src/main.js — verified, not assumed).
async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    bufferLogs: true,
  });

  const logger: Logger = app.get(WINSTON_MODULE_NEST_PROVIDER);
  app.useLogger(logger);
  // On SIGTERM (`docker compose stop worker`, redeploys) Nest runs module
  // destroy hooks, which lets @nestjs/bullmq close the Worker cleanly
  // instead of leaving its active job to be detected as stalled later.
  app.enableShutdownHooks();

  // Liveness for docker-compose's healthcheck (Step A.7) — touched every
  // 10s, checked externally via file mtime rather than a network port,
  // since this process exposes no HTTP server to probe.
  setInterval(() => {
    fs.writeFileSync('/tmp/worker-alive', '');
  }, 10_000);
  fs.writeFileSync('/tmp/worker-alive', '');

  // The same liveness for GET /health (Checkpoint G), which runs in the app
  // and cannot read this container's files. A failed beat is logged, never
  // fatal: Redis being down already shows on /health as `down`.
  const redis = app.get<Redis>(REDIS_CLIENT);
  const heartbeatKey = workerHeartbeatKey();
  const sendBeat = () =>
    beat(redis, heartbeatKey).catch((error: unknown) =>
      logger.warn('worker.heartbeat_failed', {
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  setInterval(() => void sendBeat(), HEARTBEAT_INTERVAL_MS);
  await sendBeat();
}

bootstrap();
