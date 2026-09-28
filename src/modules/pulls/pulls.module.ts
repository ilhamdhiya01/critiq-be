import { Module } from '@nestjs/common';
import { PullsController } from './pulls.controller';
import { OrgPullsController } from './org-pulls.controller';
import { PullsService } from './pulls.service';
import { IntegrationsModule } from '../integrations/integrations.module';
import { ScansModule } from '../scans/scans.module';

@Module({
  // IntegrationsModule exports GithubAppService/GitlabApiService, which
  // PullsService calls directly for live diff/file-changes lookups —
  // same reasoning as ReposModule (see its own comment).
  //
  // ScansModule: the per-PR scan routes (history, rescan) and the active-scan
  // lookup the PR lists embed.
  imports: [IntegrationsModule, ScansModule],
  controllers: [PullsController, OrgPullsController],
  providers: [PullsService],
  // Consumed by WebhooksModule (upsertFromWebhook) — PullsModule itself
  // knows nothing about webhooks, keeping the dependency one-directional.
  exports: [PullsService],
})
export class PullsModule {}
