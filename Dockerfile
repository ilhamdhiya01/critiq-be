# syntax=docker/dockerfile:1

# ---- Stage 1: build ----
FROM node:24.14.0-alpine AS builder

# Husky's `prepare` script runs on every `pnpm install` and expects a .git
# directory this build context copy doesn't have — HUSKY=0 plus
# --ignore-scripts below is a double safety net.
ENV HUSKY=0
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts

COPY . .

# Build-time only — reads schema.prisma, no DB connection needed. Produces
# src/generated/prisma/*.ts (pure TS — the PrismaPg driver adapter means no
# native query engine binary is ever downloaded here).
RUN pnpm exec prisma generate

# -> dist/src/main.js, not dist/main.js — nest build mirrors src/'s nesting
# under dist/ (see tsconfig's outDir + nest-cli's sourceRoot). Verified
# against an actual build, not assumed.
RUN pnpm run build

# `runner`'s install below deliberately does NOT use pnpm/package.json's
# own `dependencies` block: @prisma/client declares `prisma` (the CLI) as
# a peerDependency, and once pnpm has resolved that peer into the lockfile
# even once, every later install (pnpm --prod, --ignore-scripts, whatever
# flags) keeps reusing that locked resolution — pulling back in `prisma`
# and, transitively, ~250MB of tooling it depends on that the compiled app
# never uses (Prisma Studio UI, @electric-sql/pglite, react/react-dom).
# Verified by actually measuring several approaches, not assumed. A
# hand-written package.json containing only the real `dependencies` (no
# `prisma`, no devDependencies) sidesteps this: npm resolves it completely
# fresh, with nothing to inherit prisma's peer requirement from.
RUN node -e "\
  const fs = require('fs'); \
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8')); \
  fs.writeFileSync('runtime.package.json', JSON.stringify({ name: pkg.name, private: true, dependencies: pkg.dependencies }, null, 2)); \
  "

# ---- Stage 2: migrator ----
# Separate, short-lived image used only as a one-off Compose job to run
# `prisma migrate deploy` against the production DB at deploy time — NOT
# part of the long-running `app` container. Reuses `builder`'s full
# node_modules (already has `prisma`, a devDependency) instead of
# reinstalling. Kept out of `runner` below because the `prisma` package
# alone pulls in ~250MB of tooling it never needs at runtime (Prisma
# Studio UI, @electric-sql/pglite, react/react-dom) — verified by actually
# measuring it, not assumed. See `runner`'s comment below for the full
# story of why a plain --prod install doesn't avoid this on its own.
FROM node:24.14.0-alpine AS migrator

WORKDIR /app
ENV HUSKY=0

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma7.config.ts ./prisma7.config.ts
COPY --from=builder /app/package.json ./package.json

CMD ["pnpm", "exec", "prisma", "migrate", "deploy"]

# ---- Stage 3: runtime ----
FROM node:24.14.0-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production

# Alpine's BusyBox provides addgroup/adduser (not groupadd/useradd, which
# need shadow/util-linux — not present in this base image).
RUN addgroup --gid 1001 nodejs && \
    adduser --uid 1001 --ingroup nodejs --shell /bin/false --disabled-password nestjs

# npm, not pnpm, and from runtime.package.json (see builder stage comment)
# — this resolves fresh, with no lockfile history to inherit prisma's
# peerDependency resolution from. --package-lock-only+ci (rather than a
# plain `npm install`) still gets a reproducible install without needing
# to check in a whole separate lockfile for a generated file.
COPY --from=builder --chown=nestjs:nodejs /app/runtime.package.json ./package.json
RUN npm install --package-lock-only --no-audit --no-fund && \
    npm ci --no-audit --no-fund --ignore-scripts && \
    npm cache clean --force

COPY --from=builder --chown=nestjs:nodejs /app/dist ./dist

USER nestjs
EXPOSE 3001

CMD ["node", "dist/src/main.js"]
