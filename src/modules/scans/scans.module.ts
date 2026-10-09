import { Module } from '@nestjs/common';
import { RepositoryScansController } from './repository-scans.controller';
import { ScansController } from './scans.controller';
import { ScansService } from './scans.service';

// ScanQueueService, the BullMQ queue (QueueModule) and RateLimiterService
// (RedisModule) all come from global modules, so nothing is imported here.
// PullsModule imports this one for the per-PR scan routes; the reverse would
// be a cycle.
@Module({
  controllers: [ScansController, RepositoryScansController],
  providers: [ScansService],
  exports: [ScansService],
})
export class ScansModule {}
