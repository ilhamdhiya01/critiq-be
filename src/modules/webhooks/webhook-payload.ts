// Webhook bodies arrive as raw bytes from an external sender, so they are
// `any` until proven otherwise — a bare `as GithubPullRequestPayload` is a
// promise to the compiler with nothing behind it at runtime. This is not
// hypothetical: GitHub's `ping` event (sent automatically the moment a
// webhook is saved in the App settings) carries no `repository` field at
// all, and reading `payload.repository.id` off it threw
// "Cannot read properties of undefined (reading 'id')" in production.
//
// class-validator DTOs (the convention elsewhere in this repo) aren't usable
// here: webhook routes read `rawBody` so the HMAC signature can be computed
// over the exact bytes the provider signed, which bypasses ValidationPipe's
// parsed-body pipeline entirely.
//
// These guards check only the fields the service actually reads (D6 scan
// scope: project/repo id and target branch) — not the provider's full event
// schema, which is large, versioned, and mostly irrelevant here.

export interface GitlabMergeRequestPayload {
  object_kind: string;
  project: { id: number };
  object_attributes?: {
    iid: number;
    title: string;
    // MR body; null when empty. Context for the AI review prompt.
    description?: string | null;
    state: string; // opened | closed | merged | locked
    target_branch: string;
    source_branch: string;
    last_commit?: { id: string };
    // open | close | reopen | update | merge | approved | ... — decides
    // whether this delivery should trigger a scan (see WebhooksService).
    action?: string;
    // Previous head sha, present on `update` only when new commits were
    // pushed — NOT the merge base, so it is never stored as baseSha.
    oldrev?: string;
    // When the MR was opened. ISO or GitLab's older `2026-10-19 08:00:00
    // UTC` form; stored as PullRequest.openedAt.
    created_at?: string;
  };
  user?: { username: string };
}

export interface GithubPullRequestPayload {
  // opened | synchronize | reopened | closed | edited | labeled | ...
  action?: string;
  repository: { id: number };
  pull_request?: {
    number: number;
    title: string;
    // PR body; null when empty. Context for the AI review prompt.
    body?: string | null;
    state: string; // open | closed
    merged: boolean;
    user?: { login: string };
    head: { sha: string; ref: string };
    base: { ref: string; sha?: string };
    // When the PR was opened (ISO); stored as PullRequest.openedAt.
    created_at?: string;
  };
}

// Arrays are excluded: every payload shape here is a JSON object, and an
// array would otherwise pass the typeof check and then fail on field access.
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isGitlabMergeRequestPayload(
  value: unknown,
): value is GitlabMergeRequestPayload {
  if (!isRecord(value)) {
    return false;
  }
  if (typeof value.object_kind !== 'string') {
    return false;
  }
  if (!isRecord(value.project) || typeof value.project.id !== 'number') {
    return false;
  }
  // Absent for non-merge_request events, which the service filters out by
  // object_kind rather than rejecting as malformed. When present, every
  // field PullsService writes to a NOT NULL column is required here —
  // all-or-nothing: a merge_request event missing any of these is treated
  // as malformed rather than upserted with partial data.
  if (value.object_attributes !== undefined) {
    const attrs = value.object_attributes;
    if (!isRecord(attrs)) {
      return false;
    }
    if (typeof attrs.iid !== 'number') {
      return false;
    }
    if (typeof attrs.title !== 'string') {
      return false;
    }
    if (typeof attrs.state !== 'string') {
      return false;
    }
    if (typeof attrs.target_branch !== 'string') {
      return false;
    }
    if (typeof attrs.source_branch !== 'string') {
      return false;
    }
    // last_commit is genuinely optional (maps to nullable headSha) — only
    // type-checked if present, never required.
    if (
      attrs.last_commit !== undefined &&
      (!isRecord(attrs.last_commit) || typeof attrs.last_commit.id !== 'string')
    ) {
      return false;
    }
    if (attrs.action !== undefined && typeof attrs.action !== 'string') {
      return false;
    }
    if (attrs.oldrev !== undefined && typeof attrs.oldrev !== 'string') {
      return false;
    }
  }
  // Same story: optional (maps to nullable authorUsername), but validated
  // if the provider did include it.
  if (
    value.user !== undefined &&
    (!isRecord(value.user) || typeof value.user.username !== 'string')
  ) {
    return false;
  }
  return true;
}

export function isGithubPullRequestPayload(
  value: unknown,
): value is GithubPullRequestPayload {
  if (!isRecord(value)) {
    return false;
  }
  if (!isRecord(value.repository) || typeof value.repository.id !== 'number') {
    return false;
  }
  if (value.action !== undefined && typeof value.action !== 'string') {
    return false;
  }
  // Absent for the non-pull_request events a GitHub App subscription also
  // delivers (push, installation, ...); the service treats those as ignored
  // events rather than malformed ones. When present, every field
  // PullsService writes to a NOT NULL column is required here —
  // all-or-nothing: a pull_request event missing any of these is treated
  // as malformed rather than upserted with partial data.
  if (value.pull_request !== undefined) {
    const pr = value.pull_request;
    if (!isRecord(pr)) {
      return false;
    }
    if (typeof pr.number !== 'number') {
      return false;
    }
    if (typeof pr.title !== 'string') {
      return false;
    }
    if (typeof pr.state !== 'string') {
      return false;
    }
    if (typeof pr.merged !== 'boolean') {
      return false;
    }
    if (!isRecord(pr.head) || typeof pr.head.ref !== 'string') {
      return false;
    }
    // head.sha is genuinely optional (maps to nullable headSha) — only
    // type-checked if present, never required.
    if (pr.head.sha !== undefined && typeof pr.head.sha !== 'string') {
      return false;
    }
    if (!isRecord(pr.base) || typeof pr.base.ref !== 'string') {
      return false;
    }
    if (pr.base.sha !== undefined && typeof pr.base.sha !== 'string') {
      return false;
    }
    // Same story: optional (maps to nullable authorUsername).
    if (
      pr.user !== undefined &&
      (!isRecord(pr.user) || typeof pr.user.login !== 'string')
    ) {
      return false;
    }
  }
  return true;
}

// The App's own `installation` event (created, deleted, suspend,
// unsuspend, new_permissions_accepted) — GitHub sends it to every App
// regardless of the events it subscribes to. Only the action and the
// installation id are read.
export interface GithubInstallationPayload {
  action: string;
  installation: { id: number };
}

export function isGithubInstallationPayload(
  value: unknown,
): value is GithubInstallationPayload {
  return (
    isRecord(value) &&
    typeof value.action === 'string' &&
    isRecord(value.installation) &&
    typeof value.installation.id === 'number'
  );
}

// GitHub sends `ping` once when a webhook is first saved, and it carries a
// `zen` string and `hook_id` but no `repository` — so it is a perfectly
// valid delivery that simply has nothing for this service to act on.
// Distinguished from a genuinely malformed body so the logs don't accuse
// GitHub of sending junk on every webhook someone sets up.
export function isGithubPingEvent(value: unknown): boolean {
  return isRecord(value) && typeof value.zen === 'string';
}

// --- Comments (v1.5.2, two-way sync) --------------------------------------

interface GithubCommentUser {
  login: string;
  avatar_url?: string | null;
}

function isGithubCommentUser(value: unknown): value is GithubCommentUser {
  return isRecord(value) && typeof value.login === 'string';
}

// GitHub `issue_comment` — a comment in a PR's conversation (or an issue's:
// only those with `issue.pull_request` are PR comments).
export interface GithubIssueCommentPayload {
  action: string;
  repository: { id: number };
  issue: { number: number; pull_request?: unknown };
  comment: {
    id: number;
    body: string;
    user: GithubCommentUser;
    created_at: string;
  };
}

export function isGithubIssueCommentPayload(
  value: unknown,
): value is GithubIssueCommentPayload {
  return (
    isRecord(value) &&
    typeof value.action === 'string' &&
    isRecord(value.repository) &&
    typeof value.repository.id === 'number' &&
    isRecord(value.issue) &&
    typeof value.issue.number === 'number' &&
    isRecord(value.comment) &&
    typeof value.comment.id === 'number' &&
    typeof value.comment.body === 'string' &&
    typeof value.comment.created_at === 'string' &&
    isGithubCommentUser(value.comment.user)
  );
}

// GitHub `pull_request_review_comment` — a comment on a line of the diff.
export interface GithubReviewCommentPayload {
  action: string;
  repository: { id: number };
  pull_request: { number: number };
  comment: {
    id: number;
    body: string;
    path: string;
    line?: number | null;
    original_line?: number | null;
    side?: string | null;
    commit_id: string;
    in_reply_to_id?: number | null;
    user: GithubCommentUser;
    created_at: string;
  };
}

export function isGithubReviewCommentPayload(
  value: unknown,
): value is GithubReviewCommentPayload {
  if (
    !isRecord(value) ||
    typeof value.action !== 'string' ||
    !isRecord(value.repository) ||
    typeof value.repository.id !== 'number' ||
    !isRecord(value.pull_request) ||
    typeof value.pull_request.number !== 'number'
  ) {
    return false;
  }
  const comment = value.comment;
  return (
    isRecord(comment) &&
    typeof comment.id === 'number' &&
    typeof comment.body === 'string' &&
    typeof comment.path === 'string' &&
    typeof comment.commit_id === 'string' &&
    typeof comment.created_at === 'string' &&
    isGithubCommentUser(comment.user)
  );
}

// GitLab Note Hook on a merge request. GitLab sends no delete event.
export interface GitlabNotePayload {
  object_kind: 'note';
  project: { id: number };
  user: { username: string; avatar_url?: string | null };
  merge_request: { iid: number };
  object_attributes: {
    id: number;
    note: string;
    noteable_type: string;
    discussion_id?: string | null;
    system?: boolean;
    action?: string | null;
    created_at: string;
    position?: {
      new_path?: string | null;
      old_path?: string | null;
      new_line?: number | null;
      old_line?: number | null;
      head_sha?: string | null;
    } | null;
  };
}

export function isGitlabNotePayload(
  value: unknown,
): value is GitlabNotePayload {
  if (
    !isRecord(value) ||
    value.object_kind !== 'note' ||
    !isRecord(value.project) ||
    typeof value.project.id !== 'number' ||
    !isRecord(value.user) ||
    typeof value.user.username !== 'string' ||
    !isRecord(value.merge_request) ||
    typeof value.merge_request.iid !== 'number'
  ) {
    return false;
  }
  const attrs = value.object_attributes;
  return (
    isRecord(attrs) &&
    typeof attrs.id === 'number' &&
    typeof attrs.note === 'string' &&
    typeof attrs.noteable_type === 'string' &&
    typeof attrs.created_at === 'string'
  );
}

// Every GitLab webhook body: enough to find (and authenticate) the repo
// before deciding what kind of event it is.
export interface GitlabEventEnvelope {
  object_kind: string;
  project: { id: number };
}

export function isGitlabEventEnvelope(
  value: unknown,
): value is GitlabEventEnvelope {
  return (
    isRecord(value) &&
    typeof value.object_kind === 'string' &&
    isRecord(value.project) &&
    typeof value.project.id === 'number'
  );
}

// JSON.parse throws on malformed bytes; callers get `null` instead so a junk
// body is logged and dropped like any other rejected payload rather than
// unwinding to the controller's catch-all.
export function parseJsonBody(rawBody: Buffer): unknown {
  try {
    return JSON.parse(rawBody.toString('utf8')) as unknown;
  } catch {
    return null;
  }
}
