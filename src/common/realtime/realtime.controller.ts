import {
  Controller,
  HttpException,
  HttpStatus,
  Inject,
  MessageEvent,
  Param,
  Req,
  Sse,
} from '@nestjs/common';
import type { Request } from 'express';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import {
  EMPTY,
  Observable,
  catchError,
  defer,
  filter,
  finalize,
  from,
  interval,
  map,
  merge,
  of,
  share,
  switchMap,
  take,
  takeUntil,
  timer,
} from 'rxjs';
import { Logger } from 'winston';
import type { JwtPayload } from '../../modules/auth/auth.service';
import { OrgAuth } from '../decorators/org-auth.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeHub } from './realtime.hub';

export const HEARTBEAT_MS = 25_000;
export const MEMBERSHIP_RECHECK_MS = 60_000;
export const RECONNECT_MS = 5_000;
export const MAX_STREAMS_PER_USER = 5;

type RevokeReason = 'membership_revoked' | 'session_expired';

// The verified JWT, with the standard claims passport-jwt leaves on it.
type SessionUser = JwtPayload & { exp?: number };

// GET /api/v1/orgs/:orgId/events — realtime invalidation hints (SSE),
// outside the PRD; see CLAUDE.md "Realtime (SSE)". All roles: the stream
// carries ids and statuses only, never data a Viewer could not read.
@Controller('orgs/:orgId/events')
export class RealtimeController {
  // Open streams per user on this instance. Per instance, not global: one
  // app instance today, and the limit only guards against leaked tabs.
  private readonly openStreams = new Map<string, number>();

  constructor(
    private readonly hub: RealtimeHub,
    private readonly prisma: PrismaService,
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
  ) {}

  @Sse()
  @OrgAuth()
  stream(
    @Param('orgId') orgId: string,
    @Req() req: Request & { user: SessionUser },
  ): Observable<MessageEvent> {
    const userId = req.user.sub;
    // Thrown before the stream opens, so the client gets a plain 429.
    if ((this.openStreams.get(userId) ?? 0) >= MAX_STREAMS_PER_USER) {
      throw new HttpException('too_many_streams', HttpStatus.TOO_MANY_REQUESTS);
    }

    return defer(() => {
      this.track(userId, 1);
      this.logger.info('realtime.connected', {
        orgId,
        userId,
        userStreams: this.openStreams.get(userId),
      });

      const revoked$ = merge(
        this.membershipRevoked(orgId, userId),
        this.sessionExpired(req.user.exp),
      ).pipe(take(1), share());

      const live$ = merge(
        of<MessageEvent>({
          type: 'ready',
          retry: RECONNECT_MS,
          data: {
            serverTime: new Date().toISOString(),
            heartbeatMs: HEARTBEAT_MS,
          },
        }),
        this.hub.stream(orgId).pipe(
          map((event): MessageEvent => ({
            id: event.id,
            type: event.type,
            data: event,
          })),
        ),
        interval(HEARTBEAT_MS).pipe(
          map((): MessageEvent => ({ type: 'ping', data: {} })),
        ),
      ).pipe(takeUntil(revoked$));

      // The reason goes out last, then the stream completes and Nest ends
      // the response.
      return merge(
        live$,
        revoked$.pipe(
          map((reason): MessageEvent => ({
            type: 'revoked',
            data: { reason },
          })),
        ),
      ).pipe(
        finalize(() => {
          this.track(userId, -1);
          this.logger.info('realtime.disconnected', { orgId, userId });
        }),
      );
    });
  }

  // A member removed (or deactivated) while the stream is open stops
  // receiving events at the next check. A failed check keeps the stream:
  // a database blip must not disconnect every tab at once.
  private membershipRevoked(
    orgId: string,
    userId: string,
  ): Observable<RevokeReason> {
    return interval(MEMBERSHIP_RECHECK_MS).pipe(
      switchMap(() =>
        from(
          this.prisma.membership.findUnique({
            where: { userId_organizationId: { userId, organizationId: orgId } },
            select: { status: true },
          }),
        ).pipe(
          map((membership) => membership?.status === 'ACTIVE'),
          catchError(() => of(true)),
        ),
      ),
      filter((active) => !active),
      map((): RevokeReason => 'membership_revoked'),
    );
  }

  // The session cookie expires with the JWT; a stream must not outlive it.
  private sessionExpired(exp: number | undefined): Observable<RevokeReason> {
    if (!exp) {
      return EMPTY;
    }
    return timer(Math.max(0, exp * 1000 - Date.now())).pipe(
      map((): RevokeReason => 'session_expired'),
    );
  }

  private track(userId: string, delta: number): void {
    const next = (this.openStreams.get(userId) ?? 0) + delta;
    if (next <= 0) {
      this.openStreams.delete(userId);
    } else {
      this.openStreams.set(userId, next);
    }
  }
}
