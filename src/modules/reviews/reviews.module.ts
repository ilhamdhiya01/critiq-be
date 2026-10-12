import { Module } from '@nestjs/common';
import { ReviewsController } from './reviews.controller';
import { ReviewsService } from './reviews.service';

// v1.5.2. The review-sync queue comes from the global QueueModule; its
// processor runs in the worker (ReviewSyncProcessor), never here.
@Module({
  controllers: [ReviewsController],
  providers: [ReviewsService],
})
export class ReviewsModule {}
