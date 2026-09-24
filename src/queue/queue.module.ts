import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ScanQueueService } from './scan-queue.service';

@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      useFactory: (configService: ConfigService) => ({
        connection: { url: configService.getOrThrow<string>('redis.url') },
      }),
      inject: [ConfigService],
    }),
    BullModule.registerQueue({ name: 'scan' }),
  ],
  providers: [ScanQueueService],
  exports: [BullModule, ScanQueueService],
})
export class QueueModule {}
