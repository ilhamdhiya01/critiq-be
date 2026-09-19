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
  object_attributes?: { target_branch: string };
}

export interface GithubPullRequestPayload {
  repository: { id: number };
  pull_request?: { base: { ref: string } };
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
  // object_kind rather than rejecting as malformed.
  if (value.object_attributes !== undefined) {
    if (
      !isRecord(value.object_attributes) ||
      typeof value.object_attributes.target_branch !== 'string'
    ) {
      return false;
    }
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
  // events rather than malformed ones.
  if (value.pull_request !== undefined) {
    if (!isRecord(value.pull_request) || !isRecord(value.pull_request.base)) {
      return false;
    }
    if (typeof value.pull_request.base.ref !== 'string') {
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
