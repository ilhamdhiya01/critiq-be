import { Module } from '@nestjs/common';
import { IntegrationsModule } from '../integrations/integrations.module';
import { MergeService } from './merge.service';
import { ReviewsController } from './reviews.controller';
import { ReviewsService } from './reviews.service';

// v1.5.2. The review-sync queue comes from the global QueueModule; its
// processor runs in the worker (ReviewSyncProcessor), never here.
@Module({
  imports: [IntegrationsModule],
  controllers: [ReviewsController],
  providers: [ReviewsService, MergeService],
})
export class ReviewsModule {}
