import { CommentKind, DiffSide } from '../../generated/prisma/enums';
import { fromGithubReviewComment, fromGitlabNote } from './comment-events';

const note = (attrs: Record<string, unknown> = {}) => ({
  object_kind: 'note' as const,
  project: { id: 99 },
  user: { username: 'gitty', avatar_url: null },
  merge_request: { iid: 3 },
  object_attributes: {
    id: 55,
    note: 'nit',
    noteable_type: 'MergeRequest',
    discussion_id: 'd1',
    created_at: '2026-10-12T05:00:00Z',
    ...attrs,
  },
});

describe('comment events', () => {
  it('reads a GitLab diff note on the old side', () => {
    expect(
      fromGitlabNote(
        note({
          position: {
            old_path: 'a.ts',
            new_path: 'a.ts',
            old_line: 8,
            new_line: null,
            head_sha: 'abc',
          },
        }),
      ),
    ).toMatchObject({
      kind: CommentKind.INLINE,
      path: 'a.ts',
      line: 8,
      side: DiffSide.OLD,
      headSha: 'abc',
    });
  });

  it('reads an edit, and skips system notes and other noteables', () => {
    expect(fromGitlabNote(note({ action: 'update' }))?.action).toBe('edited');
    expect(fromGitlabNote(note({ system: true }))).toBeNull();
    expect(fromGitlabNote(note({ noteable_type: 'Issue' }))).toBeNull();
  });

  // GitHub nulls `line` once the line left the diff; the original stays.
  it('keeps a GitHub review comment on its original line', () => {
    expect(
      fromGithubReviewComment({
        action: 'created',
        repository: { id: 42 },
        pull_request: { number: 7 },
        comment: {
          id: 1,
          body: 'x',
          path: 'a.ts',
          line: null,
          original_line: 14,
          side: 'LEFT',
          commit_id: 'abc',
          user: { login: 'octo' },
          created_at: '2026-10-12T05:00:00Z',
        },
      }),
    ).toMatchObject({ line: 14, side: DiffSide.OLD, providerThreadKey: null });
  });
});
