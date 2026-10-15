import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import type Redis from 'ioredis';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import { Observable, Subject } from 'rxjs';
import { Logger } from 'winston';
import { REDIS_CLIENT } from '../redis/redis.constants';
import {
  REALTIME_CHANNEL_PREFIX,
  RealtimeWireEvent,
} from './realtime-event.types';

interface OrgStream {
  subject: Subject<RealtimeWireEvent>;
  listeners: number;
}

// Fans realtime events out to the SSE streams open on this app instance.
// One Redis subscriber connection for every organization (PSUBSCRIBE), not
// one per stream: a subscribed ioredis connection cannot run other
// commands, and connections per tab would not scale. Opened on the first
// stream, so the worker and tests never connect. ioredis resubscribes by
// itself after a reconnect; events published in between are lost, which
// the client covers by refetching on every reconnect of its own.
@Injectable()
export class RealtimeHub implements OnModuleDestroy {
  private subscriber: Redis | null = null;
  private readonly streams = new Map<string, OrgStream>();

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
  ) {}

  // Events of one organization only. Unsubscribing removes the listener.
  stream(orgId: string): Observable<RealtimeWireEvent> {
    return new Observable<RealtimeWireEvent>((observer) => {
      this.ensureSubscribed();
      let entry = this.streams.get(orgId);
      if (!entry) {
        entry = { subject: new Subject(), listeners: 0 };
        this.streams.set(orgId, entry);
      }
      entry.listeners += 1;
      const subscription = entry.subject.subscribe(observer);
      const owned = entry;
      return () => {
        subscription.unsubscribe();
        owned.listeners -= 1;
        if (owned.listeners === 0 && this.streams.get(orgId) === owned) {
          this.streams.delete(orgId);
        }
      };
    });
  }

  // Exposed for tests; the subscriber's pmessage handler.
  dispatch(channel: string, message: string): void {
    if (!channel.startsWith(REALTIME_CHANNEL_PREFIX)) {
      return;
    }
    const orgId = channel.slice(REALTIME_CHANNEL_PREFIX.length);
    const entry = this.streams.get(orgId);
    if (!entry) {
      return;
    }
    let event: RealtimeWireEvent;
    try {
      event = JSON.parse(message) as RealtimeWireEvent;
    } catch {
      this.logger.warn('realtime.malformed_event', { orgId });
      return;
    }
    // The channel decides the audience; an event claiming another org is
    // a publisher bug and must not reach this org's members.
    if (event?.orgId !== orgId || typeof event.type !== 'string') {
      this.logger.warn('realtime.malformed_event', { orgId });
      return;
    }
    entry.subject.next(event);
  }

  async onModuleDestroy(): Promise<void> {
    for (const entry of this.streams.values()) {
      entry.subject.complete();
    }
    this.streams.clear();
    if (this.subscriber) {
      await this.subscriber.quit().catch(() => undefined);
      this.subscriber = null;
    }
  }

  private ensureSubscribed(): void {
    if (this.subscriber) {
      return;
    }
    const subscriber = this.redis.duplicate();
    subscriber.on(
      'pmessage',
      (_pattern: string, channel: string, message: string) =>
        this.dispatch(channel, message),
    );
    subscriber.on('error', (error: Error) =>
      this.logger.warn('realtime.subscriber_error', { error: error.message }),
    );
    subscriber
      .psubscribe(`${REALTIME_CHANNEL_PREFIX}*`)
      .catch((error: Error) => {
        this.logger.warn('realtime.subscribe_failed', { error: error.message });
      });
    this.subscriber = subscriber;
  }
}
