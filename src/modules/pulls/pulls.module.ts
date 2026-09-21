import { Module } from '@nestjs/common';
import { PullsController } from './pulls.controller';
import { OrgPullsController } from './org-pulls.controller';
import { PullsService } from './pulls.service';

@Module({
  controllers: [PullsController, OrgPullsController],
  providers: [PullsService],
  // Consumed by WebhooksModule (upsertFromWebhook) — PullsModule itself
  // knows nothing about webhooks, keeping the dependency one-directional.
  exports: [PullsService],
})
export class PullsModule {}
