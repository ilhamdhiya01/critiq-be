import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { SettingsController } from './settings.controller';
import { AiModelsService } from './ai-models.service';
import { SettingsService } from './settings.service';

// RateLimiterService comes from the global RedisModule; Prisma and
// encryption from the global CommonModule.
@Module({
  imports: [AiModule],
  controllers: [SettingsController],
  providers: [SettingsService, AiModelsService],
  exports: [SettingsService],
})
export class SettingsModule {}
