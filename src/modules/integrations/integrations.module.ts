import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { IntegrationsController } from './integrations.controller';
import { IntegrationsService } from './integrations.service';
import { GithubAppService } from './github-app.service';
import { GitlabApiService } from './gitlab-api.service';
import { GithubInstallIntentService } from './github-install-intent.service';
import { GithubInstallationCallbackController } from './github-installation-callback.controller';

@Module({
  imports: [HttpModule], // still needed — GitlabApiService's HttpService-based calls use it
  controllers: [IntegrationsController, GithubInstallationCallbackController],
  providers: [
    IntegrationsService,
    GithubAppService,
    GitlabApiService,
    GithubInstallIntentService,
  ],
  // Both are consumed directly by ReposModule (branch/scan-config lookups)
  // without going through IntegrationsService, so both must be exported.
  exports: [GithubAppService, GitlabApiService],
})
export class IntegrationsModule {}
