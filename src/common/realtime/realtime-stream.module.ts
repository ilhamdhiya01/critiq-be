import { Module } from '@nestjs/common';
import { RealtimeController } from './realtime.controller';
import { RealtimeHub } from './realtime.hub';

// The SSE side of realtime events — app only (the worker publishes through
// RealtimeModule and has no HTTP adapter).
@Module({
  controllers: [RealtimeController],
  providers: [RealtimeHub],
})
export class RealtimeStreamModule {}
