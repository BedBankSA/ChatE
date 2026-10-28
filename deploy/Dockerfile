# syntax=docker/dockerfile:1.7
# ChatE production image — Next.js 16 + Node 24 (node:sqlite requires Node >= 22.5).
# Build context is the repository root:
#   docker build -f deploy/Dockerfile -t chate:latest .
#
# Public NEXT_PUBLIC_* values are inlined into the browser bundle at BUILD time,
# so they must be passed as build args (they are public, never secrets):
#   docker build -f deploy/Dockerfile \
#     --build-arg NEXT_PUBLIC_GOOGLE_CLIENT_ID=... \
#     --build-arg NEXT_PUBLIC_TURNSTILE_SITE_KEY=0x4AAAAAAFoJLWRjfC1ZYlwB \
#     -t chate:latest .
#
# The repository does NOT set output: "standalone" in next.config.ts, so this
# image runs the normal `next start` server (no standalone server.js). Keeping
# node_modules (including tsx) is what makes `npm run worker` possible in the
# same image.

FROM node:24-bookworm-slim AS deps
WORKDIR /app
# Development mode so devDependencies (next build toolchain, tsx, typescript) install.
ENV NODE_ENV=development
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json .npmrc ./
RUN npm ci --no-audit --no-fund

FROM deps AS builder
WORKDIR /app
# Explicit copies only: .env.local / .env.production must never enter the image.
COPY tsconfig.json next-env.d.ts next.config.ts postcss.config.mjs eslint.config.mjs ./
COPY src ./src
COPY migrations ./migrations
COPY scripts ./scripts
ARG NEXT_PUBLIC_GOOGLE_CLIENT_ID=""
ARG NEXT_PUBLIC_TURNSTILE_SITE_KEY=""
ENV NEXT_PUBLIC_GOOGLE_CLIENT_ID=$NEXT_PUBLIC_GOOGLE_CLIENT_ID
ENV NEXT_PUBLIC_TURNSTILE_SITE_KEY=$NEXT_PUBLIC_TURNSTILE_SITE_KEY
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:24-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3211
# Runtime packages for healthcheck + backup script fallback (debian-slim has no curl).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl sqlite3 \
 && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json next.config.ts tsconfig.json ./
COPY --from=builder /app/.next ./.next
COPY src ./src
COPY scripts ./scripts
COPY migrations ./migrations
COPY deploy/scripts ./deploy/scripts
# /data holds the SQLite file and private storage. A named volume is mounted here.
RUN mkdir -p /data/storage \
 && chown -R node:node /data /app \
 && chmod 0755 /app/deploy/scripts/*.sh
USER node
EXPOSE 3211
# No /api/health route exists in the app; /api/models is public, DB-free and returns {"ok":true}.
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3211)+'/api/models').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
# Web process only. The worker runs the same image with:
#   node node_modules/tsx/dist/cli.mjs scripts/worker.ts
CMD ["node", "node_modules/next/dist/bin/next", "start", "-H", "0.0.0.0", "-p", "3211"]
