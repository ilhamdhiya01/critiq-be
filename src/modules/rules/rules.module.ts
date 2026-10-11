import { Module } from '@nestjs/common';
import { RulesController } from './rules.controller';
import { RulesService } from './rules.service';

// Prisma comes from the global CommonModule.
@Module({
  controllers: [RulesController],
  providers: [RulesService],
})
export class RulesModule {}
