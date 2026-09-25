import * as fs from 'fs';
import { NestFactory } from '@nestjs/core';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';
import { Logger } from 'winston';
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
}

bootstrap();
