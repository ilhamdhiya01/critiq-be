import type Redis from 'ioredis';
import { Logger } from 'winston';
import { RealtimeHub } from './realtime.hub';
import type { RealtimeWireEvent } from './realtime-event.types';

function setup() {
  const subscriber = {
    on: jest.fn(),
    psubscribe: jest.fn().mockResolvedValue(1),
    quit: jest.fn().mockResolvedValue('OK'),
  };
  const redis = { duplicate: jest.fn(() => subscriber) };
  const logger = { warn: jest.fn() };
  const hub = new RealtimeHub(
    redis as unknown as Redis,
    logger as unknown as Logger,
  );
  return { hub, redis, subscriber, logger };
}

const message = (orgId: string, type = 'scan.updated') =>
  JSON.stringify({ id: 'e1', at: 'now', type, orgId });

describe('RealtimeHub', () => {
  it('opens one pattern subscription, on the first stream only', () => {
    const { hub, redis, subscriber } = setup();
    expect(redis.duplicate).not.toHaveBeenCalled();
    hub.stream('org_1').subscribe();
    hub.stream('org_2').subscribe();
    expect(redis.duplicate).toHaveBeenCalledTimes(1);
    expect(subscriber.psubscribe).toHaveBeenCalledWith('critiq:events:org:*');
  });

  // Tenant isolation: the channel decides who hears an event.
  it("delivers an event to its organization's streams only", () => {
    const { hub } = setup();
    const org1: RealtimeWireEvent[] = [];
    const org2: RealtimeWireEvent[] = [];
    hub.stream('org_1').subscribe((event) => org1.push(event));
    hub.stream('org_2').subscribe((event) => org2.push(event));

    hub.dispatch('critiq:events:org:org_1', message('org_1'));

    expect(org1).toHaveLength(1);
    expect(org2).toHaveLength(0);
  });

  it('drops an event whose body names another organization', () => {
    const { hub, logger } = setup();
    const received: RealtimeWireEvent[] = [];
    hub.stream('org_1').subscribe((event) => received.push(event));

    hub.dispatch('critiq:events:org:org_1', message('org_2'));

    expect(received).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledWith('realtime.malformed_event', {
      orgId: 'org_1',
    });
  });

  it('ignores malformed messages', () => {
    const { hub } = setup();
    const received: RealtimeWireEvent[] = [];
    hub.stream('org_1').subscribe((event) => received.push(event));
    hub.dispatch('critiq:events:org:org_1', 'not json');
    expect(received).toHaveLength(0);
  });

  it('stops delivering once the last stream of an org closes', () => {
    const { hub } = setup();
    const received: RealtimeWireEvent[] = [];
    const first = hub.stream('org_1').subscribe((e) => received.push(e));
    const second = hub.stream('org_1').subscribe((e) => received.push(e));

    first.unsubscribe();
    hub.dispatch('critiq:events:org:org_1', message('org_1'));
    expect(received).toHaveLength(1);

    second.unsubscribe();
    hub.dispatch('critiq:events:org:org_1', message('org_1'));
    expect(received).toHaveLength(1);
  });

  it('completes open streams and quits Redis on shutdown', async () => {
    const { hub, subscriber } = setup();
    const complete = jest.fn();
    hub.stream('org_1').subscribe({ complete });
    await hub.onModuleDestroy();
    expect(complete).toHaveBeenCalled();
    expect(subscriber.quit).toHaveBeenCalled();
  });
});
