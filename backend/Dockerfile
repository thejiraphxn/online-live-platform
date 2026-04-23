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

# ---------- runner (api) ----------
FROM node:20-alpine AS api
RUN corepack enable
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY package.json ./
EXPOSE 4000
CMD ["node", "dist/server.js"]

# ---------- runner (worker) ----------
FROM node:20-alpine AS worker
RUN corepack enable
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY package.json ./
CMD ["node", "dist/jobs/worker.js"]
