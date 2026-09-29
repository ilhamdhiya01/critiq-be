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

describe('RateLimiterService.tryConsume', () => {
  function limiterWith(exec: jest.Mock) {
    const multi = { incr: jest.fn(), expire: jest.fn(), exec };
    multi.incr.mockReturnValue(multi);
    multi.expire.mockReturnValue(multi);
    const logger = { warn: jest.fn() };
    const limiter = new RateLimiterService(
      { multi: () => multi } as unknown as Redis,
      logger as unknown as Logger,
    );
    return { limiter, multi, logger };
  }

  it('allows up to the limit within the window', async () => {
    const { limiter, multi } = limiterWith(
      jest.fn().mockResolvedValue([
        [null, 5],
        [null, 0],
      ]),
    );
    await expect(limiter.tryConsume('k', 5, 3600)).resolves.toBe(true);
    expect(multi.expire).toHaveBeenCalledWith('k', 3600, 'NX');
  });

  it('refuses the call past the limit', async () => {
    const { limiter } = limiterWith(
      jest.fn().mockResolvedValue([
        [null, 6],
        [null, 0],
      ]),
    );
    await expect(limiter.tryConsume('k', 5, 3600)).resolves.toBe(false);
  });

  it('fails open when Redis errors', async () => {
    const { limiter, logger } = limiterWith(
      jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    );
    await expect(limiter.tryConsume('k', 5, 3600)).resolves.toBe(true);
    expect(logger.warn).toHaveBeenCalled();
  });
});
