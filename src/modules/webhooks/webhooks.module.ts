import { Module } from '@nestjs/common';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';
import { CommentsModule } from '../comments/comments.module';
import { PullsModule } from '../pulls/pulls.module';

@Module({
  imports: [PullsModule, CommentsModule],
  controllers: [WebhooksController],
  providers: [WebhooksService],
})
export class WebhooksModule {}
