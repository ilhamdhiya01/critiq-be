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

# ---- Stage 2: runtime ----
FROM node:24.14.0-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production
ENV HUSKY=0

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

# Alpine's BusyBox provides addgroup/adduser (not groupadd/useradd, which
# need shadow/util-linux — not present in this base image).
RUN addgroup --gid 1001 nodejs && \
    adduser --uid 1001 --ingroup nodejs --shell /bin/false --disabled-password nestjs

# Full install (not --prod) — `prisma` the CLI is a devDependency, but
# docker-entrypoint.sh needs it at container start for `prisma migrate
# deploy`. This project's Prisma setup has no native binaries (driver
# adapter, see above), so keeping devDependencies costs little in image size
# and avoids the fragility of selectively re-adding just the CLI package.
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma7.config.ts ./prisma7.config.ts

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh && chown -R nestjs:nodejs /app

USER nestjs
EXPOSE 3001

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/src/main.js"]
