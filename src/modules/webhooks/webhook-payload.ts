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
    state: string; // opened | closed | merged | locked
    target_branch: string;
    source_branch: string;
    last_commit?: { id: string };
  };
  user?: { username: string };
}

export interface GithubPullRequestPayload {
  repository: { id: number };
  pull_request?: {
    number: number;
    title: string;
    state: string; // open | closed
    merged: boolean;
    user?: { login: string };
    head: { sha: string; ref: string };
    base: { ref: string };
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

// GitHub sends `ping` once when a webhook is first saved, and it carries a
// `zen` string and `hook_id` but no `repository` — so it is a perfectly
// valid delivery that simply has nothing for this service to act on.
// Distinguished from a genuinely malformed body so the logs don't accuse
// GitHub of sending junk on every webhook someone sets up.
export function isGithubPingEvent(value: unknown): boolean {
  return isRecord(value) && typeof value.zen === 'string';
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
