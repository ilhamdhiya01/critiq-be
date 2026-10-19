import type { PullRefDto } from '../../pulls/dto/pull-ref.dto';

export class ReviewActivityItemDto {
  id!: string;
  decision!: 'approve' | 'request_changes';
  // The AI review of the reviewed commit was done when the reviewer decided.
  aiAssisted!: boolean;
  sync!: { status: 'pending' | 'synced' | 'failed' };
  // Null when the reviewer's account was deleted since.
  reviewer!: { id: string; name: string; avatarUrl: string | null } | null;
  pull!: PullRefDto;
  createdAt!: Date;

  constructor(partial: ReviewActivityItemDto) {
    Object.assign(this, partial);
  }
}

export class ActivityPageDto {
  items!: ReviewActivityItemDto[];
  // Null on the last page.
  nextCursor!: string | null;
  // Per decision under the current mode filter — not narrowed by the
  // decision filter, so every tab keeps its number.
  counts!: { all: number; approve: number; request_changes: number };

  constructor(partial: ActivityPageDto) {
    Object.assign(this, partial);
  }
}
