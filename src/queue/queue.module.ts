import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SCAN_QUEUE_NAME, ScanQueueService } from './scan-queue.service';

@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      useFactory: (configService: ConfigService) => ({
        connection: { url: configService.getOrThrow<string>('redis.url') },
      }),
      inject: [ConfigService],
    }),
    BullModule.registerQueue({ name: SCAN_QUEUE_NAME }),
  ],
  providers: [ScanQueueService],
  exports: [BullModule, ScanQueueService],
})
export class QueueModule {}
