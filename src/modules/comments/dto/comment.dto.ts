import type { PullComment, User } from '../../../generated/prisma/client';
import type { CommentSyncErrorCode } from '../../integrations/provider-comment-error';

// What every comment query loads: the Critiq author, for name and avatar.
export const COMMENT_INCLUDE = {
  author: { select: { id: true, name: true, email: true, avatarUrl: true } },
} as const;

export type CommentRow = PullComment & {
  author: Pick<User, 'id' | 'name' | 'email' | 'avatarUrl'> | null;
};

export class CommentDto {
  id!: string;
  origin!: 'critiq' | 'github' | 'gitlab';
  author!: {
    name: string;
    avatarUrl: string | null;
    critiqUserId: string | null;
    providerUsername: string | null;
  };
  body!: string;
  createdAt!: Date;
  editedAt!: Date | null;
  deleted!: boolean;
  // Null for a comment that came from the provider.
  sync!: {
    status: 'pending' | 'synced' | 'failed';
    error: CommentSyncErrorCode | null;
  } | null;

  constructor(partial: CommentDto) {
    Object.assign(this, partial);
  }
}

export class CommentThreadDto {
  // The root comment's id — what a reply sends as parentId.
  id!: string;
  kind!: 'general' | 'inline';
  path!: string | null;
  line!: number | null;
  side!: 'new' | 'old' | null;
  headSha!: string | null;
  // Inline only: the PR has moved past the commit commented on.
  outdated!: boolean;
  comments!: CommentDto[];

  constructor(partial: CommentThreadDto) {
    Object.assign(this, partial);
  }
}

export function toCommentDto(row: CommentRow): CommentDto {
  const deleted = row.deletedAt !== null;
  return new CommentDto({
    id: row.id,
    origin: row.origin.toLowerCase() as CommentDto['origin'],
    author: row.author
      ? {
          name: row.author.name ?? row.author.email,
          avatarUrl: row.author.avatarUrl,
          critiqUserId: row.author.id,
          providerUsername: null,
        }
      : {
          name: row.providerAuthor ?? 'Unknown',
          avatarUrl: row.providerAuthorAvatarUrl,
          critiqUserId: null,
          providerUsername: row.providerAuthor,
        },
    body: deleted ? '' : row.body,
    createdAt: row.createdAt,
    editedAt: row.editedAt,
    deleted,
    sync: row.syncStatus
      ? {
          status: row.syncStatus.toLowerCase() as
            'pending' | 'synced' | 'failed',
          error: row.syncError as CommentSyncErrorCode | null,
        }
      : null,
  });
}

// Roots oldest first, each with its replies oldest first. A reply whose root
// is missing (should not happen) is shown as its own thread.
export function toThreads(
  rows: CommentRow[],
  pullHeadSha: string | null,
): CommentThreadDto[] {
  const sorted = [...rows].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
  );
  const roots = new Map<string, CommentThreadDto>();
  const order: CommentThreadDto[] = [];
  const thread = (root: CommentRow) => {
    const dto = new CommentThreadDto({
      id: root.id,
      kind: root.kind === 'INLINE' ? 'inline' : 'general',
      path: root.path,
      line: root.line,
      side: root.side ? (root.side.toLowerCase() as 'new' | 'old') : null,
      headSha: root.headSha,
      outdated:
        root.kind === 'INLINE' &&
        pullHeadSha !== null &&
        root.headSha !== pullHeadSha,
      comments: [toCommentDto(root)],
    });
    roots.set(root.id, dto);
    order.push(dto);
  };
  for (const row of sorted.filter((row) => row.parentId === null)) {
    thread(row);
  }
  for (const row of sorted.filter((row) => row.parentId !== null)) {
    const root = roots.get(row.parentId!);
    if (root) {
      root.comments.push(toCommentDto(row));
    } else {
      thread(row);
    }
  }
  return order;
}
