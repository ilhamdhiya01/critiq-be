import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { IntegrationsController } from './integrations.controller';
import { IntegrationsService } from './integrations.service';
import { GithubAppService } from './github-app.service';
import { GithubInstallIntentService } from './github-install-intent.service';
import { GithubInstallationCallbackController } from './github-installation-callback.controller';

@Module({
  imports: [HttpModule], // still needed — GitLab's fetchGitlabUser/fetchGitlabTokenSelf/fetchMaintainerProjects use it
  controllers: [IntegrationsController, GithubInstallationCallbackController],
  providers: [
    IntegrationsService,
    GithubAppService,
    GithubInstallIntentService,
  ],
})
export class IntegrationsModule {}
