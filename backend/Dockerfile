# ---------- base ----------
# Debian-based image: Prisma ships a `debian-openssl-3.0.x` query engine,
# and Debian has ffmpeg + OpenSSL 3 in apt. Alpine's musl variant needs
# libssl.so.1.1 which isn't in recent base images — Render fails to boot
# with: "Prisma cannot find libssl.so.1.1".
FROM node:20-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends \
      openssl \
      ffmpeg \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app

# ---------- deps ----------
FROM base AS deps
COPY package.json pnpm-lock.yaml* ./
COPY prisma ./prisma
RUN pnpm install --frozen-lockfile || pnpm install
RUN pnpm prisma generate

# ---------- builder ----------
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm prisma generate
RUN pnpm build

# ---------- runner ----------
# Single runner — the HTTP server embeds the BullMQ worker in-process by
# default (EMBED_WORKER=true). Opt-out with EMBED_WORKER=false and run
# `node dist/jobs/worker.js` as a separate process for horizontal scaling.
FROM node:20-bookworm-slim AS runner
RUN apt-get update && apt-get install -y --no-install-recommends \
      openssl \
      ffmpeg \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY package.json ./
EXPOSE 4000
# `migrate deploy` is idempotent — it applies any pending migrations and
# becomes a no-op once the DB is up to date. Safe to run on every boot.
CMD ["sh", "-c", "pnpm prisma migrate deploy && node dist/server.js"]
