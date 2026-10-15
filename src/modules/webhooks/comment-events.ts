import { CommentKind, DiffSide, Provider } from '../../generated/prisma/enums';
import type { InboundComment } from '../comments/comment-ingest.service';
import type {
  GithubIssueCommentPayload,
  GithubReviewCommentPayload,
  GitlabNotePayload,
} from './webhook-payload';

// Provider comment payloads as an InboundComment (v1.5.2). Null = nothing
// to record: an issue comment that is not on a PR, a GitLab system note or
// a note on something other than a merge request, an unknown action.

function githubAction(action: string): InboundComment['action'] | null {
  return action === 'created' || action === 'edited' || action === 'deleted'
    ? action
    : null;
}

export function fromGithubIssueComment(
  payload: GithubIssueCommentPayload,
): InboundComment | null {
  const action = githubAction(payload.action);
  if (!action || payload.issue.pull_request === undefined) {
    return null;
  }
  return {
    provider: Provider.GITHUB,
    repositoryExternalId: String(payload.repository.id),
    pullExternalId: String(payload.issue.number),
    action,
    providerCommentId: `github-issue:${payload.comment.id}`,
    providerThreadKey: null,
    kind: CommentKind.GENERAL,
    path: null,
    line: null,
    side: null,
    headSha: null,
    body: payload.comment.body,
    author: payload.comment.user.login,
    avatarUrl: payload.comment.user.avatar_url ?? null,
    createdAt: new Date(payload.comment.created_at),
  };
}

export function fromGithubReviewComment(
  payload: GithubReviewCommentPayload,
): InboundComment | null {
  const action = githubAction(payload.action);
  if (!action) {
    return null;
  }
  const { comment } = payload;
  return {
    provider: Provider.GITHUB,
    repositoryExternalId: String(payload.repository.id),
    pullExternalId: String(payload.pull_request.number),
    action,
    providerCommentId: `github-review:${comment.id}`,
    providerThreadKey: comment.in_reply_to_id
      ? `github-review:${comment.in_reply_to_id}`
      : null,
    kind: CommentKind.INLINE,
    path: comment.path,
    // `line` is null once the line left the diff; the original one stays.
    line: comment.line ?? comment.original_line ?? null,
    side: comment.side === 'LEFT' ? DiffSide.OLD : DiffSide.NEW,
    headSha: comment.commit_id,
    body: comment.body,
    author: comment.user.login,
    avatarUrl: comment.user.avatar_url ?? null,
    createdAt: new Date(comment.created_at),
  };
}

export function fromGitlabNote(
  payload: GitlabNotePayload,
): InboundComment | null {
  const attrs = payload.object_attributes;
  if (attrs.noteable_type !== 'MergeRequest' || attrs.system) {
    return null;
  }
  const position = attrs.position ?? null;
  const onOldSide =
    position !== null && position.new_line == null && position.old_line != null;
  return {
    provider: Provider.GITLAB,
    repositoryExternalId: String(payload.project.id),
    pullExternalId: String(payload.merge_request.iid),
    // Newer GitLab says create/update; older sends no action at all.
    action: attrs.action === 'update' ? 'edited' : 'created',
    providerCommentId: `gitlab-note:${attrs.id}`,
    providerThreadKey: attrs.discussion_id
      ? `gitlab-discussion:${attrs.discussion_id}`
      : null,
    kind: position ? CommentKind.INLINE : CommentKind.GENERAL,
    path: position ? (position.new_path ?? position.old_path ?? null) : null,
    line: position
      ? ((onOldSide ? position.old_line : position.new_line) ?? null)
      : null,
    side: position ? (onOldSide ? DiffSide.OLD : DiffSide.NEW) : null,
    headSha: position?.head_sha ?? null,
    body: attrs.note,
    author: payload.user.username,
    avatarUrl: payload.user.avatar_url ?? null,
    createdAt: new Date(attrs.created_at),
  };
}
