import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ReviewDecision } from '../../generated/prisma/enums';
import { ActivityPageDto } from './dto/activity.dto';
import { ACTIVITY_PAGE_SIZE, ActivityQueryDto } from './dto/activity-query.dto';
import {
  REVIEW_ACTIVITY_SELECT,
  toReviewActivityItem,
} from './review-activity';

interface CursorPosition {
  createdAt: Date;
  id: string;
}

// The last item of a page, as an opaque string the client hands back.
export function encodeCursor(position: CursorPosition): string {
  return Buffer.from(
    `${position.createdAt.toISOString()}|${position.id}`,
  ).toString('base64url');
}

export function decodeCursor(cursor: string): CursorPosition {
  const raw = Buffer.from(cursor, 'base64url').toString('utf8');
  const separator = raw.indexOf('|');
  const createdAt = new Date(raw.slice(0, separator));
  const id = raw.slice(separator + 1);
  if (separator <= 0 || !id || Number.isNaN(createdAt.getTime())) {
    throw new BadRequestException({
      field: 'cursor',
      message: 'invalid_cursor',
    });
  }
  return { createdAt, id };
}

// The Activity menu: the organization's review decisions, newest first,
// one page at a time. v1 covers reviews only — the PRD's audit log of every
// mutation waits for the audit log table (CLAUDE.md "Activity").
@Injectable()
export class ActivityService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    organizationId: string,
    query: ActivityQueryDto,
  ): Promise<ActivityPageDto> {
    const limit = query.limit ?? ACTIVITY_PAGE_SIZE;
    const after = query.cursor ? decodeCursor(query.cursor) : null;
    // The tabs' numbers follow the mode filter, not the decision filter.
    const scope = {
      organizationId,
      ...(query.mode ? { aiAssisted: query.mode === 'ai_assisted' } : {}),
    };

    const [rows, perDecision] = await Promise.all([
      this.prisma.pullReview.findMany({
        where: {
          ...scope,
          ...(query.decision
            ? {
                decision:
                  query.decision === 'approve'
                    ? ReviewDecision.APPROVE
                    : ReviewDecision.REQUEST_CHANGES,
              }
            : {}),
          // Keyset, not offset: a review arriving between two "load more"
          // clicks must not shift the next page onto items already shown.
          ...(after
            ? {
                OR: [
                  { createdAt: { lt: after.createdAt } },
                  { createdAt: after.createdAt, id: { lt: after.id } },
                ],
              }
            : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        select: REVIEW_ACTIVITY_SELECT,
      }),
      this.prisma.pullReview.groupBy({
        by: ['decision'],
        where: scope,
        _count: { _all: true },
      }),
    ]);

    const page = rows.slice(0, limit);
    const last = page.at(-1);
    const countOf = (decision: ReviewDecision) =>
      perDecision.find((group) => group.decision === decision)?._count._all ??
      0;
    const approve = countOf(ReviewDecision.APPROVE);
    const requestChanges = countOf(ReviewDecision.REQUEST_CHANGES);

    return new ActivityPageDto({
      items: page.map(toReviewActivityItem),
      nextCursor: rows.length > limit && last ? encodeCursor(last) : null,
      counts: {
        all: approve + requestChanges,
        approve,
        request_changes: requestChanges,
      },
    });
  }
}
