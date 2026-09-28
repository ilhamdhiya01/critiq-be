import Redis from 'ioredis';
import { Logger } from 'winston';
import { RateLimiterService } from './rate-limiter.service';

function setup(set: jest.Mock) {
  const logger = { warn: jest.fn() };
  const limiter = new RateLimiterService(
    { set } as unknown as Redis,
    logger as unknown as Logger,
  );
  return { limiter, logger };
}

describe('RateLimiterService', () => {
  it('grants the slot when SET NX succeeds', async () => {
    const set = jest.fn().mockResolvedValue('OK');
    const { limiter } = setup(set);
    await expect(limiter.tryAcquire('k', 30)).resolves.toBe(true);
    expect(set).toHaveBeenCalledWith('k', '1', 'EX', 30, 'NX');
  });

  it('refuses while the key exists', async () => {
    const { limiter } = setup(jest.fn().mockResolvedValue(null));
    await expect(limiter.tryAcquire('k', 30)).resolves.toBe(false);
  });

  it('fails open, with a warning, when Redis errors', async () => {
    const { limiter, logger } = setup(
      jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    );
    await expect(limiter.tryAcquire('k', 30)).resolves.toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      'ratelimit.redis_unavailable',
      expect.objectContaining({ key: 'k' }),
    );
  });
});
