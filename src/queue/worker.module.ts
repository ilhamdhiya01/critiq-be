import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { RedisModule } from '../common/redis/redis.module';
import { RealtimeModule } from '../common/realtime/realtime.module';
import { AiModule } from '../modules/ai/ai.module';
import { AiScanModule } from '../modules/ai/scan/ai-scan.module';
import { IntegrationsModule } from '../modules/integrations/integrations.module';
import { PullsModule } from '../modules/pulls/pulls.module';
import { AiScanProcessor } from './ai-scan.processor';
import { QueueModule } from './queue.module';
import { CommentSyncProcessor } from './comment-sync.processor';
import { InvitationEmailProcessor } from './invitation-email.processor';
import { MailModule } from '../common/mail/mail.module';
import { ReviewSyncProcessor } from './review-sync.processor';
import { ScanProcessor } from './scan.processor';

// Root of the worker process (src/worker.ts). createApplicationContext
// builds its own module graph, so every @Global() module the processor
// needs (CommonModule, RedisModule, RealtimeModule, QueueModule) must be
// imported here — they are not inherited from AppModule. PullsModule is
// imported for PullsService.getDiff (provider credential resolution + diff
// fetch); its controllers are registered but inert, since there is no HTTP
// adapter in this process. RealtimeModule only publishes: the worker's
// state changes reach the app's SSE streams through Redis.
//
// AiModule/AiScanModule: the AI review step after a static scan (v1.5.1
// langkah 2) — AiScanProcessor runs here only.
@Module({
  imports: [
    CommonModule,
    RedisModule,
    RealtimeModule,
    QueueModule,
    PullsModule,
    IntegrationsModule,
    AiModule,
    AiScanModule,
    MailModule,
  ],
  providers: [
    ScanProcessor,
    AiScanProcessor,
    ReviewSyncProcessor,
    CommentSyncProcessor,
    InvitationEmailProcessor,
  ],
})
export class WorkerModule {}
