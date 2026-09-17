import { Module } from '@nestjs/common';
import { ReposController } from './repos.controller';
import { IntegrationRepoBranchesController } from './integration-repo-branches.controller';
import { ReposService } from './repos.service';
import { IntegrationsModule } from '../integrations/integrations.module';

@Module({
  // IntegrationsModule exports GithubAppService/GitlabApiService, which
  // ReposService calls directly for provider branch/repo lookups without
  // going through IntegrationsService itself.
  imports: [IntegrationsModule],
  controllers: [ReposController, IntegrationRepoBranchesController],
  providers: [ReposService],
})
export class ReposModule {}
