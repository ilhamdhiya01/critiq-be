import { Global, Module } from '@nestjs/common';
import { RealtimePublisher } from './realtime.publisher';

// Publishing only — imported by the app and the worker. The stream side
// (RealtimeStreamModule: Redis subscriber + SSE endpoint) is app-only.
@Global()
@Module({
  providers: [RealtimePublisher],
  exports: [RealtimePublisher],
})
export class RealtimeModule {}
