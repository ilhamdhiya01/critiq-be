# Critiq — AI-Assisted Code Review (Backend)

Critiq is a code review platform that scans pull/merge request **diffs only** (never the full codebase) on every push, flags Critical-severity findings, and lets reviewers choose a review mode per PR — **Manual** or **AI-Assisted**. The final decision (Approve / Request Changes) is always made by a human; AI never auto-approves or auto-merges.

This repository (`critiq-be`) contains the backend API for Critiq, built with **NestJS**.

> Status: MVP v1.1 (in development) · Internal · Cititex Engineering

---

## Overview

Critiq unifies pull requests from **GitHub (org)** and **GitLab (self-hosted)** into a single list, applies branch-level review policies, and gives teams an audit trail over every review decision. This service owns:

- OAuth login (GitHub / GitLab) and session issuance
- Webhook ingestion (PR/MR push → queued diff scan)
- Diff-only scanning against the 6 Critical rules + AI provider analysis
- Quality gate evaluation, branch policy enforcement, and review decisions
- Audit logging for every mutation

**MVP goals**

- Speed up review turnaround (target: AI-assisted ~3× faster than manual)
- Catch Critical issues (secrets, crashes, breaking changes, missing error handling, N+1 queries, failing CI) before they reach the main branch via a quality gate
- Give admins per-branch policy control (`Manual only` / `Allow AI` / `Require both`), with a full audit log of every decision and review mode used

**Explicitly out of scope for MVP**

- Major / Minor / Info severity tiers (Critical-only for now)
- Full-codebase scanning, auto-fix, or auto-merge
- Code hosts other than GitHub and GitLab

---

## Roles

| Role         | Example      | Permissions                                                                                                      |
| ------------ | ------------ | ------------------------------------------------------------------------------------------------------------------- |
| **Admin**    | Tech Lead    | Everything a Reviewer can do, plus: connect/disconnect repos, manage branch policy, rules, AI provider, and team |
| **Reviewer** | Engineers    | Review PRs (choose mode), approve / request changes, comment                                                     |
| **Viewer**   | Stakeholders | Read-only: dashboard, insights, activity                                                                         |

Role checks are enforced server-side via a `RolesGuard` on every mutating endpoint — never trust the frontend to hide an action as the only safeguard.

---

## Core Business Rules

These are backend invariants, not UI details:

- **Human-in-the-loop is absolute** — Approve/Request Changes can only be performed by a human, in every review mode. No scan job or AI job ever calls the review endpoint itself.
- **Diff-only scanning** — one scan per PR push; Critiq never reads the full codebase.
- **Quality gate** = `PASSED` when there are 0 active Critical findings on enabled rules and CI is green; `FAILED` otherwise. Both conditions are checked explicitly.
- **Policy precedence** — branch policy (`Manual only` / `Require both`) overrides the reviewer's personal mode preference. A `branch/*` pattern applies to all branches with that prefix. The `effective_policy` on a PR is snapshotted at open/mode-selection time, not live-joined, so audit history stays accurate if the branch policy changes later.
- **Require both** — approval is rejected (`422`) until `manual_confirmation: true` is explicitly sent, even when AI analysis is complete.
- **Audit log** — every mutation (review decision, mode change, policy change, connect/disconnect repo, provider change) is recorded with actor, action, entity, and timestamp.
- **AI provider API key** — stored encrypted at rest; API responses always return it masked, never plaintext.

---

## Tech Stack

| Area | Choice | Why |
|---|---|---|
| Framework | NestJS 11 | modular DI, first-class TypeScript |
| Database | PostgreSQL | relational, fits audit log & per-branch policy modeling |
| ORM | Prisma | type-safe client, straightforward migration workflow |
| Queue | BullMQ + Redis | async scan/regenerate/rescan jobs, retry/backoff built in |
| Auth | Passport.js (`@nestjs/passport`) | `passport-github2` for GitHub; GitLab uses a custom strategy on `passport-oauth2` (no well-maintained official strategy exists). Note GitLab has two distinct flows: OAuth login vs. connecting a self-hosted instance via Personal Access Token |
| Session | JWT (`@nestjs/jwt` + `passport-jwt`) | Bearer token on every authenticated endpoint |
| Validation | `class-validator` / `class-transformer` | DTO validation at controller boundaries |
| Config | `@nestjs/config` + `joi` | fail-fast startup if required env vars are missing |

> Dependencies are added incrementally per build phase, not all at once — see Build Roadmap below.

---

## Getting Started

### Prerequisites

- **Node.js** 22.x — this repo is developed against `v22.17.0` (via `nvm`)
- **pnpm** — installed via Corepack
- **PostgreSQL** ≥ 15 — local instance or Docker
- **Redis** ≥ 7 — required once the queue (Fase 4) is wired up; not needed for Fase 0–3

### Install & Run

```bash
git clone <repo-url> critiq-be
cd critiq-be
nvm use
pnpm install
cp .env.example .env   # fill in the values below
pnpm start:dev
```

The API runs at `http://localhost:3000` by default (prefix `/api/v1`).

### Other scripts

```bash
pnpm build        # production build
pnpm start:prod    # run the production build locally
pnpm lint          # lint and autofix
pnpm test          # unit tests
pnpm test:e2e      # end-to-end tests
pnpm test:cov      # test coverage
```

### Environment Variables

| Variable                  | Description                                                        |
| -------------------------- | -------------------------------------------------------------------- |
| `DATABASE_URL`             | PostgreSQL connection string (Prisma)                               |
| `REDIS_URL`                | Redis connection string (BullMQ, from Fase 4 onward)                |
| `JWT_SECRET`               | Signing secret for session JWTs                                     |
| `ENCRYPTION_KEY`           | At-rest encryption key for AI provider API keys and GitLab PATs     |
| `GITHUB_CLIENT_ID`         | GitHub OAuth App client ID (org `cititex`)                          |
| `GITHUB_CLIENT_SECRET`     | GitHub OAuth App client secret                                      |
| `GITLAB_CLIENT_ID`         | GitLab OAuth App client ID (self-hosted instance)                   |
| `GITLAB_CLIENT_SECRET`     | GitLab OAuth App client secret                                      |

> `.env.example` is the source of truth — keep it in sync whenever a new variable is introduced in a phase.

---

## API Contract

REST + JSON, prefix `/api/v1`, auth via Bearer token. All mutations are recorded to the audit log server-side.

| Group               | Examples                                                                                                |
| -------------------- | ---------------------------------------------------------------------------------------------------------- |
| Auth & session       | `POST /auth/oauth/:provider`, `POST /auth/logout`, `GET /me`                                            |
| Dashboard            | `GET /dashboard/summary`                                                                                 |
| Repositories         | `GET/POST/DELETE /repos`, `GET/PUT /repos/:id/protection`, `POST /repos/:id/rescan`                      |
| Pull Requests        | `GET /pulls`, `GET /pulls/:id`, `GET /pulls/:id/diff`, `PUT /pulls/:id/mode`, `POST /pulls/:id/review`   |
| Comments             | `GET/POST /pulls/:id/comments`                                                                           |
| Rules                | `GET/PUT /rules`                                                                                          |
| Activity & Insights  | `GET /activity?decision=&mode=`, `GET /insights?range=8w`                                                |
| Settings             | `GET/PUT /settings/provider`, `GET/PUT /settings/notifications`, `GET/PUT /team/:id/role`                |
| Integrations         | `POST /integrations/gitlab`, `GET /integrations`, `GET /integrations/:source/candidates`                 |
| Search               | `GET /search?q=` (powers frontend `⌘K`)                                                                  |
| Webhooks (inbound)   | `POST /webhooks/github`, `POST /webhooks/gitlab`                                                          |

Full request/response payload examples (e.g. `GET /pulls/482`, `POST /pulls/482/review`) live in the product PRD — treat that as the source of truth rather than duplicating full shapes here as the API evolves.

---

## Folder Structure

Feature modules, not layer folders — a change to one feature should stay within one module directory.

```
src/
  modules/
    auth/          # OAuth GitHub/GitLab, JWT, RolesGuard
    users/
    repos/         # connect/disconnect, branch protection
    pulls/         # PR/MR unification, findings, diff, review mode
    reviews/       # approve/request_changes decisions, audit trail
    comments/
    rules/         # 6 toggleable Critical rules
    activity/      # audit log queries
    insights/
    settings/      # AI provider, notifications, team
    integrations/  # GitHub/GitLab connections, webhook ingestion
  common/
    decorators/
    filters/
    guards/
    interceptors/
    pipes/
  config/
  database/        # Prisma module/service
  queue/           # BullMQ processors
  main.ts
  app.module.ts
prisma/
  schema.prisma
  migrations/
```

---

## Build Roadmap

Development proceeds in phases, each with a checkpoint before moving to the next:

1. **Fase 0 — Foundation**: `ConfigModule` + env validation, fail-fast startup
2. **Fase 1 — Database schema**: Prisma models for users, repos, PRs, findings, reviews, audit log
3. **Fase 2 — Auth module**: GitHub/GitLab OAuth, JWT sessions, role guards
4. **Fase 3 — Core CRUD (read-side)**: `repos`, `pulls` read endpoints, DTO conventions
5. **Fase 4 — Webhook ingestion + queue**: signature verification, async diff scan, AI provider abstraction

---

## Known Open Questions

Carried over from the product PRD — resolve before relying on the affected behavior:

- Behavior when the AI provider is down: silent fallback to Manual mode, or block AI mode entirely?
- Diff size limit for AI analysis (context window) and handling of oversized diffs
- Whether inline comments sync back to GitHub/GitLab as native review comments
- Audit log retention and export requirements (CSV/SIEM)
- Final validation of the A/B/C quality rating formula against historical data
- Personal API token permission scope (read-only vs full) and expiry policy

---

## License

Internal — Cititex Engineering. Not for external distribution.
