import { Module } from '@nestjs/common';
import { AiScanService } from './ai-scan.service';

// Deciding and enqueueing AI reviews — used by the worker (after a static
// scan) and the HTTP app (regenerate). The `ai` queue, Prisma, Redis and
// config come from global modules. The processor itself is registered only
// in WorkerModule.
@Module({
  providers: [AiScanService],
  exports: [AiScanService],
})
export class AiScanModule {}
