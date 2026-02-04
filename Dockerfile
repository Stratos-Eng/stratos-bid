# syntax=docker/dockerfile:1

# Multi-stage Dockerfile for Next.js (standalone)

FROM node:20-bookworm-slim AS deps
WORKDIR /app

# Install dependencies (including dev deps needed for build)
COPY package.json package-lock.json ./
RUN npm ci

FROM node:20-bookworm-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
# Next.js/TypeScript can be memory-hungry during `next build`.
# App Platform Docker builds were OOM'ing around ~2GB heap; allow a larger heap.
ENV NODE_OPTIONS=--max-old-space-size=4096

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Build Next.js
RUN npm run build

FROM node:20-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# If you use sharp/canvas/etc, you may need additional OS packages here.

# Next.js standalone output
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

EXPOSE 3000
ENV PORT=3000

CMD ["node", "server.js"]
