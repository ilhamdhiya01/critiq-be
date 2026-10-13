import { CallHandler, ExecutionContext, Sse } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { lastValueFrom, of } from 'rxjs';
import { ResponseInterceptor } from './response.interceptor';

class Handlers {
  plain(this: void) {
    return undefined;
  }

  @Sse()
  stream(this: void) {
    return undefined;
  }
}

const contextFor = (handler: () => unknown) =>
  ({
    getHandler: () => handler,
    getClass: () => Handlers,
  }) as unknown as ExecutionContext;

const handled = (value: unknown) =>
  ({ handle: () => of(value) }) as unknown as CallHandler;

describe('ResponseInterceptor', () => {
  const interceptor = new ResponseInterceptor(new Reflector());

  it('wraps a return value in the envelope', async () => {
    const result = interceptor.intercept(
      contextFor(Handlers.prototype.plain),
      handled({ id: 1 }),
    );
    await expect(lastValueFrom(result)).resolves.toEqual({
      data: { id: 1 },
      message: 'Success',
    });
  });

  // Each SSE value is one frame: wrapping it would bury the event name.
  it('passes Server-Sent Events frames through untouched', async () => {
    const frame = { type: 'ping', data: {} };
    const result = interceptor.intercept(
      contextFor(Handlers.prototype.stream),
      handled(frame),
    );
    await expect(lastValueFrom(result)).resolves.toBe(frame);
  });
});
