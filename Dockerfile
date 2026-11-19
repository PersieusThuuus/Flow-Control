# =============================================================================
# FlowControl — production container image
#
# Multi-stage build for Next.js `output: "standalone"` (see next.config.ts):
#   1. deps/build stage: install dependencies with Bun, run `bun run build`
#      (the build script is `next build` followed by copying .next/static and
#      public/ into .next/standalone/ so the standalone tree is self-contained).
#   2. runtime stage: copy only the standalone output, the Prisma schema and
#      the volume mount points for the SQLite database and the document vault.
#
# The container runs the standalone server with Bun, mirroring the project's
# `start` script: `bun .next/standalone/server.js`.
# =============================================================================

# ---------------------------------------------------------------------------
# Stage 1 — dependencies and build
# ---------------------------------------------------------------------------
FROM oven/bun:1 AS build

WORKDIR /app

# Install dependencies first (better layer caching).
COPY package.json bun.lock ./
RUN bun install

# Copy the application source.
COPY . .

# `next build` needs a DATABASE_URL resolvable at build time (Prisma client is
# imported by route handlers). The build-time value is irrelevant at runtime —
# the runtime container overrides it with the volume-backed path below.
ARG DATABASE_URL="file:./db/custom.db"
ENV DATABASE_URL=${DATABASE_URL}

RUN bunx prisma generate && bun run build

# ---------------------------------------------------------------------------
# Stage 2 — minimal runtime
# ---------------------------------------------------------------------------
FROM oven/bun:1 AS runtime

WORKDIR /app

# curl: container healthcheck. openssl/libssl: required by the Prisma SQLite
# query engine on Debian-based images.
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl openssl \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Volume-backed persistence points (mount these in docker-compose / k8s):
#   /app/db      — SQLite database file
#   /app/storage — private document vault (must never be web-served directly)
ENV DATABASE_URL="file:/app/db/custom.db"
ENV STORAGE_DIR="/app/storage"
# SESSION_SECRET is REQUIRED in production (>= 16 chars). Provide it via
# docker-compose `env_file` or an orchestrator secret — the application
# refuses to run login flows without it (fail-closed, see src/server/auth.ts).
ENV SESSION_SECRET=""

# Standalone Next.js server (self-contained: server.js + .next + node_modules),
# preserving the same path layout as the project's `start` script.
COPY --from=build /app/.next/standalone ./.next/standalone

# Prisma schema for out-of-band schema management inside the container
# (e.g. `bunx prisma db push` against the mounted volume on first boot).
COPY --from=build /app/prisma ./prisma

# Create the persistent directories (mounted as volumes in deployment).
RUN mkdir -p /app/db /app/storage

EXPOSE 3000

CMD ["bun", ".next/standalone/server.js"]
