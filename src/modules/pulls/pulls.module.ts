import { Module } from '@nestjs/common';
import { PullsController } from './pulls.controller';
import { OrgPullsController } from './org-pulls.controller';
import { PullsService } from './pulls.service';
import { IntegrationsModule } from '../integrations/integrations.module';
import { ScansModule } from '../scans/scans.module';
import { AiScanModule } from '../ai/scan/ai-scan.module';
import { PullSummaryService } from './pull-summary.service';

@Module({
  // IntegrationsModule exports GithubAppService/GitlabApiService, which
  // PullsService calls directly for live diff/file-changes lookups —
  // same reasoning as ReposModule (see its own comment).
  //
  // ScansModule: the per-PR scan routes (history, rescan) and the active-scan
  // lookup the PR lists embed.
  //
  // AiScanModule: GET …/summary and regenerate (v1.5.1 langkah 2).
  imports: [IntegrationsModule, ScansModule, AiScanModule],
  controllers: [PullsController, OrgPullsController],
  providers: [PullsService, PullSummaryService],
  // Consumed by WebhooksModule (upsertFromWebhook) — PullsModule itself
  // knows nothing about webhooks, keeping the dependency one-directional.
  exports: [PullsService],
})
export class PullsModule {}
