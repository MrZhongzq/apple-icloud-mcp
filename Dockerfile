# syntax=docker/dockerfile:1
#
# Three stages: deps (production dependencies only), build (full dependencies +
# tsc), runtime (node:22-alpine, non-root, only dist/ and the production
# node_modules/ make it into the final image).
#
# This Dockerfile builds the HTTP entrypoint (src/bin/http.ts -> dist/bin/http.js).
# The stdio entrypoint (dist/bin/stdio.js) needs none of the environment this
# image requires. Seven variables are HTTP-only (read by loadHttpConfig in
# src/core/config.ts): PUBLIC_URL, ADMIN_PASSWORD_HASH and TOKEN_ENCRYPTION_KEY
# (required), plus PORT, TOKEN_STORE_PATH, ENVELOPE_KEY_PATH and TRUST_PROXY
# (optional) -- see README.md "Remote HTTP transport only" for each one.

# ---- deps: production dependencies only, cached separately from source changes ----
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- build: full dependencies (incl. typescript), compile src/ -> dist/ ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.test.json ./
COPY src ./src
RUN npm run build

# ---- runtime: minimal image, non-root user, no source/devDependencies ----
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# The official node:22-alpine image already ships an unprivileged `node` user
# (uid 1000). Create the token-store directory and hand it to that user
# *before* switching to it -- and before any volume is mounted over it, so a
# freshly-created named volume inherits this ownership instead of root's.
# See README.md "Remote deployment" / CLAUDE.md: skipping this step makes the
# first client registration fail on a fresh deployment, because the OAuth
# token store can't be written.
RUN mkdir -p /app/data && chown -R node:node /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

USER node

# Matches loadHttpConfig's own defaults (src/core/config.ts) -- set explicitly
# here so the image is correct even if someone changes WORKDIR later.
ENV PORT=17733
ENV TOKEN_STORE_PATH=/app/data/tokens.json.enc

EXPOSE 17733

# /health needs no auth and answers a constant 200 the moment the HTTP server
# is listening -- see src/server/httpApp.ts::createHealthHandler.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --quiet --tries=1 --spider "http://127.0.0.1:${PORT:-17733}/health" || exit 1

CMD ["node", "dist/bin/http.js"]
