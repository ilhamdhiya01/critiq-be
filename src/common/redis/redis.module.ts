import { Global, Module } from '@nestjs/common';
import { REDIS_CLIENT } from './redis.constants';
import Redis from 'ioredis';
import { ConfigService } from '@nestjs/config';

// Separate ioredis instance from BullMQ's own connection (QueueModule) —
// BullMQ requires maxRetriesPerRequest: null and different blocking-command
// behavior than plain SET/GET usage, so the two must not share a client.
@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      useFactory: (configService: ConfigService) =>
        new Redis(configService.getOrThrow<string>('redis.url')),
      inject: [ConfigService],
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule {}
