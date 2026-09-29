# Critiq — AI-Assisted Code Review (Backend)

Critiq is a **multi-organization SaaS** code review platform that scans pull/merge request **diffs only** (never the full codebase) on every push, flags Critical-severity findings, and lets reviewers choose a review mode per PR — **Manual** or **AI-Assisted**. The final decision (Approve / Request Changes) is always made by a human; AI never auto-approves or auto-merge

Every customer company is one **Organization** — the owner of its connected repos, GitLab instance, members, branch policy, rules, AI provider, and audit log. Data is strictly isolated between organizations.

This repository (`critiq-be`) contains the backend API for Critiq, built with **NestJS**.

> Status: MVP v1.5 (release v1.5.0 in development) · Internal · Cititex Engineering
>
> **v1.5 (D7) — asynchronous scan pipeline**: webhooks only enqueue (202 in
> < 300 ms, no provider I/O); a separate `worker` process (same image,
> `dist/src/worker.js`) fetches the diff, runs Critical-only static rules on
> added lines, and stores `scans` / `findings`. Redis 7 + BullMQ. Findings in
> test files, docs, fixtures, comments, or inside regex literals are **stored
> but suppressed** — not counted, not notified, not annotated. AI analysis follows
> in v1.5.1.
>
> Credentials (since v1.4): login (GitHub or GitLab.com) is identity only.
> GitLab repo access uses an **organization-owned access token** pasted by an
> Admin; GitHub repo access uses a GitHub App installation. See `CLAUDE.md` for
> rationale and for the list of places where the code intentionally differs
> from the PRD.

---

## Overview

Critiq unifies pull requests from **GitHub (org)** and **GitLab (self-hosted)** into a single list, applies branch-level review policies, and gives teams an audit trail over every review decision. This service owns:

- OAuth login (GitHub / GitLab), session issuance, and self-serve organization provisioning
- Webhook ingestion (PR/MR push → queued diff scan, organization resolved from the connected repo, per-repo scan scope)
- Diff-only scanning: 30 static Critical rules (secrets, eval/SQL/shell injection, insecure TLS, leftover debugger, Dockerfile/CORS config) in v1.5.0; AI provider analysis in v1.5.1
- Quality gate evaluation, branch policy enforcement, and review decisions
- Audit logging for every mutation, scoped per organization

**MVP goals**

- Speed up review turnaround (target: AI-assisted ~3× faster than manual)
- Catch Critical issues (secrets, crashes, breaking changes, missing error handling, N+1 queries, failing CI) before they reach the main branch via a quality gate
- Give admins per-branch policy control (`Manual only` / `Allow AI` / `Require both`), with a full audit log of every decision and review mode used
- Absolute data isolation between organizations on a single shared platform (multi-tenancy)

**Explicitly out of scope for MVP**

- Major / Minor / Info severity tiers (Critical-only for now)
- Full-codebase scanning, auto-fix, or auto-merge
- Code hosts other than GitHub and GitLab
- Billing, quotas, or subscription plans per organization (post-MVP)

---

## Roles

Roles belong to a **membership** (user × organization), not to the user — the
same person can hold a different role in each organization they belong to
(e.g. Admin in one company's org, Viewer in another's).

| Role         | Example         | Permissions (within that organization)                                                                                                     |
| ------------ | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **Admin**    | Org's tech lead | Everything a Reviewer can do, plus: connect/disconnect repos, manage branch policy, rules, AI provider, and members (invite & change role) |
| **Reviewer** | Engineers       | Review PRs (choose mode), approve / request changes, comment                                                                               |
| **Viewer**   | Stakeholders    | Read-only: dashboard, insights, activity                                                                                                   |

Role checks are enforced server-side via `OrgRolesGuard` (`common/decorators/org-auth.decorator.ts`) on every endpoint scoped to an organization — it re-verifies membership + role against the database for the `:orgId` in the route on every request, rather than trusting a role embedded in the session token, since a token's role is only valid for the organization that was active when it was issued. Never trust the frontend to hide an action as the only safeguard.

---

## Core Business Rules

These are backend invariants, not UI details:

- **Human-in-the-loop is absolute** — Approve/Request Changes can only be performed by a human, in every review mode. No scan job or AI job ever calls the review endpoint itself.
- **Diff-only scanning** — one scan per PR push; Critiq never reads the full codebase, and rules only evaluate added (`+`) lines.
- **Suppressed findings are not findings** — a finding in a test file, doc, fixture, source-code comment, or regex literal is stored with a `suppressedReason` (`test_file` > `comment` > `regex_literal`) but excluded from `criticalCount`, notifications, and diff annotations. Config/infra files (`.env`, `docker-compose*`, `Dockerfile*`, `*.tf`, …) are never suppressed as `test_file` or `comment` — a credential commented out there is still in git history.
- **Quality gate** = `PASSED` when there are 0 active Critical findings on enabled rules and CI is green; `FAILED` otherwise. Both conditions are checked explicitly.
- **Policy precedence** — branch policy (`Manual only` / `Require both`) overrides the reviewer's personal mode preference. A `branch/*` pattern applies to all branches with that prefix. The `effective_policy` on a PR is snapshotted at open/mode-selection time, not live-joined, so audit history stays accurate if the branch policy changes later.
- **Require both** — approval is rejected (`422`) until `manual_confirmation: true` is explicitly sent, even when AI analysis is complete.
- **Audit log** — every mutation (review decision, mode change, policy change, connect/disconnect repo, provider change) is recorded per organization with actor, role, action, entity, review mode, and timestamp.
- **AI provider API key** — stored encrypted at rest per organization; API responses always return it masked, never plaintext.
- **Absolute organization isolation** — no cross-organization query, listing, or notification anywhere in the codebase.
- **Organization slug is globally unique**; organization name does not have to be.
- **An organization always has at least one Admin** — the last Admin cannot be demoted or leave.

---

## Tech Stack

| Area       | Choice                                  | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Framework  | NestJS 11                               | modular DI, first-class TypeScript                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Database   | PostgreSQL                              | relational, fits audit log & per-branch policy modeling                                                                                                                                                                                                                                                                                                                                                                                                         |
| ORM        | Prisma                                  | type-safe client, straightforward migration workflow                                                                                                                                                                                                                                                                                                                                                                                                            |
| Queue      | BullMQ 6 + Redis 7                      | async scan jobs processed by a separate `worker` process; retry/backoff built in; Redis also backs webhook delivery dedupe and rate limits                                                                                                                                                                                                                                                                                                                      |
| Auth       | Passport.js (`@nestjs/passport`)        | GitHub: OAuth login for identity today, migrating to a GitHub App installation for repo access (org-level, not a user-scoped token — larger migration, not yet scheduled). GitLab: identity-only OAuth login (`passport-oauth2`, `read_user` scope, one fixed Critiq-owned app on gitlab.com). Repo access is a separate, org-level access token (group or personal) pasted by an Admin and verified against the GitLab API — never derived from anyone's login |
| Session    | JWT (`@nestjs/jwt` + `passport-jwt`)    | httpOnly session cookie issued and verified by the backend (the frontend never handles the token)                                                                                                                                                                                                                                                                                                                                                               |
| Validation | `class-validator` / `class-transformer` | DTO validation at controller boundaries                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Config     | `@nestjs/config` + `joi`                | fail-fast startup if required env vars are missing                                                                                                                                                                                                                                                                                                                                                                                                              |

> Dependencies are added incrementally per build phase, not all at once — see Build Roadmap below.

---

## Getting Started

### Prerequisites

- **Node.js** 24.x (the Docker image uses `node:24.14.0-alpine`)
- **pnpm** — installed via Corepack
- **PostgreSQL** ≥ 15 — local instance or Docker
- **Redis** ≥ 7 — required: the app enqueues scans and dedupes webhooks through it. Locally: `docker run -d --name critiq-redis -p 6379:6379 --restart unless-stopped redis:7-alpine`

### Install & Run

```bash
git clone <repo-url> critiq-be
cd critiq-be
nvm use
pnpm install
cp .env.example .env   # fill in the values below
pnpm start:dev
```

The API runs at `http://localhost:3001` by default (prefix `/api/v1`; HTTPS when `certs/localhost*.pem` from mkcert are present). Scans also need the worker: `pnpm start:worker:dev` in a second terminal.

### Other scripts

```bash
pnpm build        # production build
pnpm start:prod    # run the production build locally
pnpm start:worker:dev  # scan worker (separate process), watch mode
pnpm start:worker:prod # scan worker from the production build
pnpm scan:enqueue      # enqueue a scan by hand (debugging)
pnpm lint          # lint and autofix
pnpm test          # unit tests
pnpm test:e2e      # end-to-end tests
pnpm test:cov      # test coverage
```

### Environment Variables

| Variable                                       | Description                                                                                                                                                                                               |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                 | PostgreSQL connection string (Prisma)                                                                                                                                                                     |
| `REDIS_URL`                                    | Redis connection string (BullMQ queue, webhook dedupe, rate limits) — required                                                                                                                            |
| `SCAN_CONCURRENCY`                             | Scan jobs a worker processes in parallel (default `3`)                                                                                                                                                    |
| `SCAN_JOB_TIMEOUT_MS`                          | Hard deadline per scan job, enforced inside the processor (default `120000`)                                                                                                                              |
| `SCAN_MAX_DIFF_BYTES`                          | Scannable diff size limit; larger diffs fail with `diff_too_large`, not retried (default `1048576`)                                                                                                       |
| `AI_CONCURRENCY`                               | AI review jobs a worker processes in parallel (default `2`)                                                                                                                                               |
| `AI_MAX_INPUT_TOKENS` / `AI_MAX_OUTPUT_TOKENS` | Per-scan prompt budget (default `60000`, files dropped from the end past it) and response cap (default `8000`; a reply cut off at the cap fails as `output_truncated`)                                    |
| `AI_TIMEOUT_MS`                                | Timeout of one provider call (default `90000`)                                                                                                                                                            |
| `AI_CONTEXT_LINES`                             | Lines of head-file context around each hunk sent to the AI (default `30`)                                                                                                                                 |
| `AI_MAX_DIFF_BYTES`                            | Diffs larger than this skip AI review with `skipped_too_large` (default `204800`)                                                                                                                         |
| `AI_KEEP_DEDUPED`                              | Keep AI findings that duplicate a static one, suppressed as `dedupe_static` (default `false`)                                                                                                             |
| `JWT_SECRET`                                   | Signing secret for session JWTs                                                                                                                                                                           |
| `ENCRYPTION_KEY`                               | At-rest encryption key for GitLab access tokens (per-organization) and AI provider API keys                                                                                                               |
| `GITHUB_CLIENT_ID`                             | GitHub OAuth App client ID — identity login only; repo access is moving to a GitHub App installation (see `CLAUDE.md`)                                                                                    |
| `GITHUB_CLIENT_SECRET`                         | GitHub OAuth App client secret                                                                                                                                                                            |
| `GITHUB_REDIRECT_URL`                          | GitHub OAuth callback URL                                                                                                                                                                                 |
| `GITLAB_CLIENT_ID`                             | GitLab.com OAuth App client ID — identity login only, one fixed Critiq-owned app (not per-instance)                                                                                                       |
| `GITLAB_CLIENT_SECRET`                         | GitLab.com OAuth App client secret                                                                                                                                                                        |
| `GITLAB_REDIRECT_URL`                          | GitLab.com OAuth callback URL                                                                                                                                                                             |
| `AI_COMPAT_HTTP_ALLOWLIST`                     | Optional, comma-separated hosts an `openai_compatible` base URL may use over plain `http://` or on a private/internal address (e.g. `vllm.internal,localhost`). Everything else must be public `https://` |

> GitLab **repo access** credentials (instance URL + access token) are **not**
> env vars — as of PRD v1.4 they're submitted per-organization by an Admin via
> `POST /orgs/:orgId/integrations/gitlab` and stored encrypted on the
> organization's `Integration` row (see `src/modules/integrations/`). There is
> no per-instance OAuth app registration anymore (F18 was removed from the
> product in v1.4) — any GitLab instance (gitlab.com or self-hosted) is
> reachable with just an instance URL + a group/personal access token.
>
> There is no `.env.example`: `src/config/validation.schema.ts` (Joi, fail-fast at
> startup) is the source of truth for which variables exist and which are required.

---

## API Contract

REST + JSON, prefix `/api/v1`, auth via Bearer token (backed by an httpOnly session cookie — see `CLAUDE.md`). All mutations are recorded to the organization's audit log server-side.

**Global endpoints** (no organization prefix — either identity-level, or the organization is resolved from context rather than the URL):

| Group              | Examples                                                                                                                                                                                        |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth & session     | `GET /auth/github`, `GET /auth/gitlab` (identity-only, `read_user` scope), `GET /auth/:provider/callback`, `POST /auth/logout`, `GET /me`, `GET/POST/DELETE /me/tokens`                         |
| Organizations      | `GET /me/orgs` (list orgs + role, powers the org switcher), `POST /orgs` (self-serve create; never auto-creates an integration — connecting GitLab is always a separate, explicit Admin action) |
| Webhooks (inbound) | `POST /webhooks/github`, `POST /webhooks/gitlab` — organization resolved from the connected repo; `202 {scanId}` when a scan is enqueued, `401` only for a bad signature, `200` otherwise       |
| Health             | `GET /health` — db, redis, queue counts, worker heartbeat (planned: release v1.5.0, Checkpoint G)                                                                                               |

**Everything else is scoped to one organization**, prefixed `/api/v1/orgs/:orgId/...` — role is evaluated from the caller's `Membership` on `:orgId` (403 if not a member or role isn't sufficient), never from a global role on the token:

| Group               | Examples                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Organization admin  | `PATCH .../` (rename), `GET .../members`, `POST .../invites`, `PUT/DELETE .../members/:userId`                                                                                                                                                                                                                                                                                                                               |
| Dashboard           | `GET .../dashboard/summary`                                                                                                                                                                                                                                                                                                                                                                                                  |
| Repositories        | `GET/POST/DELETE .../repos`, `GET .../repos/:id/branches`, `GET/PUT .../repos/:id/scan-config`, `POST .../repos/:id/rescan[?stale=1]`                                                                                                                                                                                                                                                                                        |
| Pull Requests       | `GET .../pulls` (org-wide), `GET .../repos/:repoId/pulls[/:id]` (with `latestScan`, `activeScan`), `GET .../repos/:repoId/pulls/:id/diff` (with `annotations`, `suppressedAnnotations`, and the `annotationsScanId`/`annotationsHeadSha` they came from), `GET .../pulls/:id/summary` (AI summary, all roles), `POST .../pulls/:id/summary/regenerate` (Admin/Reviewer); planned: `PUT .../mode`, `POST .../review` (v1.5.2) |
| Scans               | `GET/POST .../repos/:repoId/pulls/:id/scans` (history · manual re-scan `{full?}`, Admin/Reviewer; later pushes are incremental), `GET .../scans/:scanId` (status, progress, queue position), `GET .../scans/:scanId/findings[?status=active\|resolved\|all&includeSuppressed=false]` (finding status `new/persisted/reopened/resolved`)                                                                                      |
| Comments            | `GET/POST .../pulls/:id/comments`                                                                                                                                                                                                                                                                                                                                                                                            |
| Rules               | `GET/PUT .../rules`                                                                                                                                                                                                                                                                                                                                                                                                          |
| Activity & Insights | `GET .../activity?decision=&mode=`, `GET .../insights?range=8w`                                                                                                                                                                                                                                                                                                                                                              |
| Settings            | `GET/PUT .../settings/ai` (Admin: provider, model, base URL, per-provider API key — write-only, consent, locale, daily token budget), `POST .../settings/ai/test` (test connection, 5/hour; always `200`, outcome in `ok` + `error.code`); planned: `GET/PUT .../settings/notifications`                                                                                                                                     |
| Integrations        | `GET .../integrations`, `POST .../integrations/gitlab` (`{"instance_url", "token"}` — verified against the GitLab API, idempotent: calling again replaces the token), `DELETE .../integrations/gitlab`, `GET .../integrations/gitlab/health`, `GET .../integrations/gitlab/candidates`                                                                                                                                       |
| Search              | `GET .../search?q=` (powers frontend `⌘K`)                                                                                                                                                                                                                                                                                                                                                                                   |

`GET .../members` + `PUT/DELETE .../members/:userId` replace the old
`GET /team` / `PUT /team/:id/role` — those are removed as of PRD v1.2.

Full request/response payload examples (e.g. `GET /orgs/:orgId/pulls/482`, `POST /orgs/:orgId/pulls/482/review`) live in the product PRD — treat that as the source of truth rather than duplicating full shapes here as the API evolves.

---

## Folder Structure

Feature modules, not layer folders — a change to one feature should stay within one module directory.

```
src/
  modules/
    auth/          # OAuth GitHub/GitLab, JWT, self-serve organization provisioning
    organizations/ # list/create organizations, org switcher support
    users/
    repos/         # connect/disconnect, branch protection
    pulls/         # PR/MR unification, findings, diff, review mode
    scans/         # scan history, detail + progress, findings, manual re-scan
    webhooks/      # inbound GitHub/GitLab webhooks → enqueue scan
    reviews/       # approve/request_changes decisions, audit trail
    comments/
    rules/         # 6 toggleable Critical rules
    activity/      # audit log queries
    insights/
    ai/            # AI provider adapters (anthropic, openai, openai_compatible), factory, SSRF guard
    settings/      # AI provider settings + test connection; later notifications, members
    integrations/  # GitHub App / GitLab org-level access token lifecycle, webhook ingestion
  common/
    decorators/
    filters/
    guards/
    interceptors/
    pipes/
  config/
  queue/           # QueueModule, ScanQueueService, WorkerModule, ScanProcessor
    rules/         # static rule definitions + fixtures, path filter, suppression
    diff/          # unified-diff parser
  scripts/         # one-off CLI scripts (e.g. enqueue-scan)
  main.ts          # HTTP app
  worker.ts        # scan worker process (no HTTP)
  app.module.ts
prisma/
  schema.prisma
  migrations/
```

---

## Build Roadmap

Foundation phases (config, schema, auth, read-side CRUD) are done. From PRD v1.5
the work follows the release roadmap in PRD §13 — one theme per release, order
binding. `CLAUDE.md` has the detailed done/pending breakdown and the places where
the code intentionally differs from the PRD.

| Release | Theme                                                                                                                                             | Status                          |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| v1.4.1  | Onboarding per provider (D4)                                                                                                                      | Released                        |
| v1.4.2  | Tenancy (D5) & scan scope per repo (D6)                                                                                                           | Released                        |
| v1.5.0  | Scan pipeline, static rules (D7): Redis + BullMQ, worker, `scans`/`findings`, suppression, scan/findings API, `annotations`, `/health`            | In progress (`/health` pending) |
| v1.5.1  | AI review: step 1 per-org AI provider setup (done) · step 2 AI scan, summary, `source: ai` findings · step 3 incremental scan & finding lifecycle | In progress                     |
| v1.5.2  | Human-in-the-loop: review decisions, Require both, review mode, audit log                                                                         | Planned                         |
| v1.5.3  | Quality gate to provider (commit status / check run), A/B/C rating                                                                                | Planned                         |
| v1.6    | Backlog: comment sync, Major/Minor, glob branches, token lifecycle cron, email/Slack                                                              | Undecided                       |

---

## Known Open Questions

Carried over from the product PRD — resolve before relying on the affected behavior:

- Behavior when the AI provider is down: silent fallback to Manual mode, or block AI mode entirely?
- Scan scope (D6): is a `release/*` wildcard needed in MVP, or exact branch names until someone asks?
- Scan scope (D6): when a branch is added to scope, scan already-open PRs targeting it retroactively, or wait for the next push?
- Diff size limit for AI analysis (context window) — static analysis is already capped at 1 MB (D7); the AI limit is decided in v1.5.1
- Scans (D7): should PRs already open when v1.5.0 deploys be backfilled automatically, or only via F11 manual re-scan?
- Scans (D7): Major/Minor rules — per-organization opt-in, or Critical-only until AI summary is stable?
- Scans (D7): block comments (`/* … */`, `"""…"""`) opened before the first added line are invisible to a diff-only scan, so a secret inside one stays active — acceptable, or fetch file context?
- Scans (D7): a value-only entropy rule (`secret.high_entropy`, credentials with no telling key name) was removed from v1.5.0 — propose it formally, or leave uncovered?
- Whether inline comments sync back to GitHub/GitLab as native review comments
- Audit log retention and export requirements (CSV/SIEM)
- Final validation of the A/B/C quality rating formula against historical data
- Personal API token permission scope (read-only vs full) and expiry policy
- Organization slug changes: redirect from the old slug, or immutable once set?
- Organization ownership transfer and deletion (data retention, grace period)
- One GitHub org connected to two different Critiq organizations — allowed, or claimed exclusively by the first?
- Per-user organization limits on a free tier; SSO enforcement / domain claiming per organization (enterprise)
- Invite expiry, re-sending, and whether an invite can force a specific OAuth provider
- Tokens without `expires_at` (older self-hosted instances): treat as 365 days, or force the Admin to enter a date?
- Personal access tokens: is a Settings badge enough warning, or should Admins also get periodic nudges to migrate to a group token?
- More than one GitLab instance per organization — real need or edge case for now?
- Login for self-hosted-only GitLab teams with no GitHub/GitLab.com account: email magic link, or OAuth to their instance (needs per-instance app registration again)? Post-MVP candidate.

---

## License

Internal — Cititex Engineering. Not for external distribution.
