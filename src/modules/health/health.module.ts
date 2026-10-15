import { Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

// Checkpoint G. Redis, Prisma and the queues come from global modules.
@Module({
  imports: [SettingsModule],
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
