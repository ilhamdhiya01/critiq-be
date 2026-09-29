import { Module } from '@nestjs/common';
import { AiProviderFactory } from './ai-provider.factory';

// Provider adapters + factory. PrismaService, EncryptionService and
// ConfigService come from the global CommonModule. Exported so the scan
// worker can build an organization's provider in v1.5.1 step 2.
@Module({
  providers: [AiProviderFactory],
  exports: [AiProviderFactory],
})
export class AiModule {}
