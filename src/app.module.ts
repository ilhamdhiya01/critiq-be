import { Module } from '@nestjs/common';
import { AuthModule } from './modules/auth/auth.module';
import { OrganizationsModule } from './modules/organizations/organizations.module';
import { IntegrationsModule } from './modules/integrations/integrations.module';
import { ReposModule } from './modules/repos/repos.module';
import { PullsModule } from './modules/pulls/pulls.module';
import { WebhooksModule } from './modules/webhooks/webhooks.module';
import { CommonModule } from './common/common.module';
import { QueueModule } from './queue/queue.module';
import { RedisModule } from './common/redis/redis.module';

@Module({
  imports: [
    CommonModule,
    RedisModule,
    AuthModule,
    OrganizationsModule,
    IntegrationsModule,
    ReposModule,
    PullsModule,
    WebhooksModule,
    QueueModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
