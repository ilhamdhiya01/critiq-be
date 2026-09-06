import { Module } from '@nestjs/common';
import { AuthModule } from './modules/auth/auth.module';
import { IntegrationsModule } from './modules/integrations/integrations.module';
import { OrganizationsModule } from './modules/organizations/organizations.module';
import { CommonModule } from './common/common.module';

@Module({
  imports: [CommonModule, AuthModule, OrganizationsModule, IntegrationsModule],
  controllers: [],
  providers: [],
})
export class AppModule {}
