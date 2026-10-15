import { randomUUID } from 'crypto';
import { Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import { Logger } from 'winston';
import { PrismaService } from '../prisma/prisma.service';
import { REDIS_CLIENT } from '../redis/redis.constants';
import {
  CommentChange,
  RealtimeEventInput,
  RealtimeWireEvent,
  realtimeChannel,
} from './realtime-event.types';

// Fields holding a Prisma enum value; lowercased on the wire.
const ENUM_FIELDS = new Set([
  'status',
  'aiStatus',
  'syncStatus',
  'state',
  'source',
]);

export function toWire(
  event: RealtimeEventInput,
  id: string = randomUUID(),
  at: Date = new Date(),
): RealtimeWireEvent {
  const wire: Record<string, unknown> = { id, at: at.toISOString() };
  for (const [key, value] of Object.entries(event)) {
    wire[key] =
      ENUM_FIELDS.has(key) && typeof value === 'string'
        ? value.toLowerCase()
        : value;
  }
  return wire as unknown as RealtimeWireEvent;
}

// Publishes realtime events (SSE) to the organization's Redis channel, from
// the app and from the worker. Call it after the write has committed —
// never inside a $transaction callback — or the client refetches before
// the data is there.
//
// Never throws: a lost event is covered by the client's fallback polling,
// while a failed publish turning a webhook or a finished scan into an error
// would not be. Callers can await it without a try/catch.
@Injectable()
export class RealtimePublisher {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly prisma: PrismaService,
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
  ) {}

  async publish(event: RealtimeEventInput): Promise<void> {
    try {
      await this.redis.publish(
        realtimeChannel(event.orgId),
        JSON.stringify(toWire(event)),
      );
    } catch (error) {
      this.logger.warn('realtime.publish_failed', {
        orgId: event.orgId,
        type: event.type,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // The scan's state as it is in the database now: callers that only hold
  // a scan id (AI status changes, the processors) need not know its PR.
  async scanChanged(scanId: string): Promise<void> {
    const scan = await this.load('scan', () =>
      this.prisma.scan.findUnique({
        where: { id: scanId },
        select: {
          organizationId: true,
          repositoryId: true,
          pullId: true,
          status: true,
          aiStatus: true,
        },
      }),
    );
    if (!scan) {
      return;
    }
    await this.publish({
      type: 'scan.updated',
      orgId: scan.organizationId,
      repoId: scan.repositoryId,
      pullId: scan.pullId,
      scanId,
      status: scan.status,
      aiStatus: scan.aiStatus,
    });
  }

  async reviewChanged(reviewId: string): Promise<void> {
    const review = await this.load('review', () =>
      this.prisma.pullReview.findUnique({
        where: { id: reviewId },
        select: {
          organizationId: true,
          pullId: true,
          syncStatus: true,
          pullRequest: { select: { repositoryId: true } },
        },
      }),
    );
    if (!review) {
      return;
    }
    await this.publish({
      type: 'review.updated',
      orgId: review.organizationId,
      repoId: review.pullRequest.repositoryId,
      pullId: review.pullId,
      reviewId,
      syncStatus: review.syncStatus,
    });
  }

  async commentChanged(
    commentId: string,
    change: CommentChange,
  ): Promise<void> {
    const comment = await this.load('comment', () =>
      this.prisma.pullComment.findUnique({
        where: { id: commentId },
        select: {
          organizationId: true,
          pullId: true,
          pullRequest: { select: { repositoryId: true } },
        },
      }),
    );
    if (!comment) {
      return;
    }
    await this.publish({
      type: 'comment.updated',
      orgId: comment.organizationId,
      repoId: comment.pullRequest.repositoryId,
      pullId: comment.pullId,
      commentId,
      change,
    });
  }

  // A lookup failure is a lost event, like a failed publish.
  private async load<T>(
    entity: string,
    query: () => Promise<T | null>,
  ): Promise<T | null> {
    try {
      return await query();
    } catch (error) {
      this.logger.warn('realtime.publish_failed', {
        entity,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }
}
