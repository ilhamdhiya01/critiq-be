import { HttpException, MessageEvent } from '@nestjs/common';
import type { Request } from 'express';
import { Subject, Subscription } from 'rxjs';
import { Logger } from 'winston';
import type { JwtPayload } from '../../modules/auth/auth.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  HEARTBEAT_MS,
  MAX_STREAMS_PER_USER,
  MEMBERSHIP_RECHECK_MS,
  RealtimeController,
} from './realtime.controller';
import { RealtimeHub } from './realtime.hub';
import type { RealtimeWireEvent } from './realtime-event.types';

jest.mock('../prisma/prisma.service', () => ({ PrismaService: class {} }));
// @nestjs/passport ships an ESM-only build this CommonJS Jest setup cannot
// load; the guards are not what these tests are about.
jest.mock('../decorators/org-auth.decorator', () => ({
  OrgAuth: () => () => undefined,
}));

type SessionRequest = Request & { user: JwtPayload & { exp?: number } };

function setup() {
  const events = new Subject<RealtimeWireEvent>();
  const hub = { stream: jest.fn(() => events.asObservable()) };
  const prisma = {
    membership: {
      findUnique: jest.fn().mockResolvedValue({ status: 'ACTIVE' }),
    },
  };
  const controller = new RealtimeController(
    hub as unknown as RealtimeHub,
    prisma as unknown as PrismaService,
    { info: jest.fn() } as unknown as Logger,
  );
  return { controller, hub, prisma, events };
}

const request = (exp?: number) =>
  ({ user: { sub: 'user_1', exp } }) as unknown as SessionRequest;

function open(
  controller: RealtimeController,
  req: SessionRequest = request(),
): { frames: MessageEvent[]; done: () => boolean; sub: Subscription } {
  const frames: MessageEvent[] = [];
  let completed = false;
  const sub = controller.stream('org_1', req).subscribe({
    next: (frame) => frames.push(frame),
    complete: () => {
      completed = true;
    },
  });
  return { frames, done: () => completed, sub };
}

describe('RealtimeController', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('opens with a ready frame carrying the reconnect delay', () => {
    const { controller } = setup();
    const { frames, sub } = open(controller);
    expect(frames[0]).toMatchObject({ type: 'ready', retry: 5000 });
    sub.unsubscribe();
  });

  it("forwards the org's events as named frames", () => {
    const { controller, hub, events } = setup();
    const { frames, sub } = open(controller);
    const event = {
      id: 'e1',
      at: 'now',
      type: 'scan.updated',
      orgId: 'org_1',
    } as RealtimeWireEvent;
    events.next(event);
    expect(hub.stream).toHaveBeenCalledWith('org_1');
    expect(frames[1]).toEqual({ id: 'e1', type: 'scan.updated', data: event });
    sub.unsubscribe();
  });

  it('sends a heartbeat', () => {
    const { controller } = setup();
    const { frames, sub } = open(controller);
    jest.advanceTimersByTime(HEARTBEAT_MS);
    expect(frames.at(-1)).toEqual({ type: 'ping', data: {} });
    sub.unsubscribe();
  });

  // A member removed while the stream is open must stop receiving events.
  it('revokes the stream once the membership is gone', async () => {
    const { controller, prisma, events } = setup();
    const { frames, done } = open(controller);
    prisma.membership.findUnique.mockResolvedValue(null);

    await jest.advanceTimersByTimeAsync(MEMBERSHIP_RECHECK_MS);

    expect(frames.at(-1)).toEqual({
      type: 'revoked',
      data: { reason: 'membership_revoked' },
    });
    expect(done()).toBe(true);
    const count = frames.length;
    events.next({ id: 'e2', at: 'now', type: 'scan.updated', orgId: 'org_1' });
    expect(frames).toHaveLength(count);
  });

  // A database blip must not disconnect every open tab.
  it('keeps the stream when the membership check fails', async () => {
    const { controller, prisma } = setup();
    const { done, sub } = open(controller);
    prisma.membership.findUnique.mockRejectedValue(new Error('db down'));
    await jest.advanceTimersByTimeAsync(MEMBERSHIP_RECHECK_MS);
    expect(done()).toBe(false);
    sub.unsubscribe();
  });

  it('ends the stream when the session expires', () => {
    const { controller } = setup();
    const exp = Math.floor(Date.now() / 1000) + 30;
    const { frames, done } = open(controller, request(exp));
    jest.advanceTimersByTime(30_000);
    expect(frames.at(-1)).toEqual({
      type: 'revoked',
      data: { reason: 'session_expired' },
    });
    expect(done()).toBe(true);
  });

  it('refuses a stream past the per-user limit, until one closes', () => {
    const { controller } = setup();
    const open$ = Array.from({ length: MAX_STREAMS_PER_USER }, () =>
      open(controller),
    );
    expect(() => controller.stream('org_1', request())).toThrow(HttpException);
    open$[0].sub.unsubscribe();
    expect(() => open(controller).sub.unsubscribe()).not.toThrow();
    open$.slice(1).forEach(({ sub }) => sub.unsubscribe());
  });
});
