# ---------- base ----------
FROM node:20-alpine AS base
RUN corepack enable && apk add --no-cache libc6-compat
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
FROM node:20-alpine AS runner
RUN corepack enable
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY package.json ./
EXPOSE 4000
CMD ["node", "dist/server.js"]
