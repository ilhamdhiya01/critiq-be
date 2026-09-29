import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { RedisModule } from '../common/redis/redis.module';
import { AiModule } from '../modules/ai/ai.module';
import { AiScanModule } from '../modules/ai/scan/ai-scan.module';
import { PullsModule } from '../modules/pulls/pulls.module';
import { AiScanProcessor } from './ai-scan.processor';
import { QueueModule } from './queue.module';
import { ScanProcessor } from './scan.processor';

// Root of the worker process (src/worker.ts). createApplicationContext
// builds its own module graph, so every @Global() module the processor
// needs (CommonModule, RedisModule, QueueModule) must be imported here —
// they are not inherited from AppModule. PullsModule is imported for
// PullsService.getDiff (provider credential resolution + diff fetch);
// its controllers are registered but inert, since there is no HTTP
// adapter in this process.
//
// AiModule/AiScanModule: the AI review step after a static scan (v1.5.1
// langkah 2) — AiScanProcessor runs here only.
@Module({
  imports: [
    CommonModule,
    RedisModule,
    QueueModule,
    PullsModule,
    AiModule,
    AiScanModule,
  ],
  providers: [ScanProcessor, AiScanProcessor],
})
export class WorkerModule {}
