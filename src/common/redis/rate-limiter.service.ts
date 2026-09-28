import { Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import { Logger } from 'winston';
import { REDIS_CLIENT } from './redis.constants';

// One-slot-per-window limiter: the first caller in a window gets the slot,
// everyone else is refused until the key expires. Enough for "one manual
// rescan per PR per 30 s"; not a general token bucket.
@Injectable()
export class RateLimiterService {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
  ) {}

  // true = allowed. Fails open: a Redis outage must not turn every rate-
  // limited endpoint into a 500, and the thing being protected (enqueueing a
  // scan) needs Redis anyway, so it fails on its own right after.
  async tryAcquire(key: string, ttlSeconds: number): Promise<boolean> {
    try {
      const result = await this.redis.set(key, '1', 'EX', ttlSeconds, 'NX');
      return result === 'OK';
    } catch (error) {
      this.logger.warn('ratelimit.redis_unavailable', {
        key,
        error: error instanceof Error ? error.message : String(error),
      });
      return true;
    }
  }
}
