import { Module } from '@nestjs/common';
import { CommentIngestService } from './comment-ingest.service';
import { CommentsController } from './comments.controller';
import { CommentsService } from './comments.service';

// v1.5.2. The comment-sync queue comes from the global QueueModule; its
// processor runs in the worker. CommentIngestService is for the webhooks.
@Module({
  controllers: [CommentsController],
  providers: [CommentsService, CommentIngestService],
  exports: [CommentIngestService],
})
export class CommentsModule {}
