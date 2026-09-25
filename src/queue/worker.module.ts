import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { RedisModule } from '../common/redis/redis.module';
import { PullsModule } from '../modules/pulls/pulls.module';
import { QueueModule } from './queue.module';
import { ScanProcessor } from './scan.processor';

// Root of the worker process (src/worker.ts). createApplicationContext
// builds its own module graph, so every @Global() module the processor
// needs (CommonModule, RedisModule, QueueModule) must be imported here —
// they are not inherited from AppModule. PullsModule is imported for
// PullsService.getDiff (provider credential resolution + diff fetch);
// its controllers are registered but inert, since there is no HTTP
// adapter in this process.
@Module({
  imports: [CommonModule, RedisModule, QueueModule, PullsModule],
  providers: [ScanProcessor],
})
export class WorkerModule {}
