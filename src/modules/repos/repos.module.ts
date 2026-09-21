import { Module } from '@nestjs/common';
import { ReposController } from './repos.controller';
import { IntegrationRepoBranchesController } from './integration-repo-branches.controller';
import { ReposService } from './repos.service';
import { IntegrationsModule } from '../integrations/integrations.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  // IntegrationsModule exports GithubAppService/GitlabApiService, which
  // ReposService calls directly for provider branch/repo lookups without
  // going through IntegrationsService itself.
  //
  // AuthModule is for AuthService.issueSessionToken: connecting the first
  // repo completes onboarding, which the session token carries, so the
  // controller reissues it — same reason OrganizationsModule imports it.
  imports: [IntegrationsModule, AuthModule],
  controllers: [ReposController, IntegrationRepoBranchesController],
  providers: [ReposService],
})
export class ReposModule {}
