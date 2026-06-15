# ─────────────────────────────────────────────────────────────
#  invoicing-service Dockerfile
#  Multi-stage: slim Node builder compiles TS; runtime is the
#  official Playwright image (Chromium + libs preinstalled).
# ─────────────────────────────────────────────────────────────

# ── Stage 1: Builder ────────────────────────────────────────
# Slim Node 22 base — just enough to install deps and run tsc.
# Build artifacts (node_modules, dist) get copied to the runtime
# stage; nothing from this layer ends up in the final image.
FROM node:22-bookworm-slim AS builder

WORKDIR /build

# Enable pnpm via corepack — Node ≥16.13 ships with this, no
# `npm install -g pnpm` pollution and the lockfile is honoured.
RUN corepack enable

# Install deps first — they change less often than source, so this
# layer caches well. Cache busts only when package.json or
# pnpm-lock.yaml change.
COPY package.json pnpm-lock.yaml ./
COPY pnpm-workspace.yaml* ./
RUN pnpm install --frozen-lockfile

# Copy sources and build TypeScript → dist/.
# tsconfig.build.json is the emit config (rootDir=src, outDir=dist).
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build

# ── Stage 2: Runtime ────────────────────────────────────────
# Official Playwright image bundles Chromium + system libraries
# (fontconfig, libnss3, libxkbcommon, etc.) so we don't have to
# chase missing .so files. The :noble variant = Ubuntu 24.04,
# matching the VPS host kernel.
#
# Includes a non-root user `pwuser` (UID 1000) with home at
# /home/pwuser. Running as non-root is required by Chromium's
# default sandbox (we don't pass --no-sandbox in pdf.ts).
#
# Bump this tag in lockstep with the `playwright` version in
# package.json. Mismatched browser/Node versions cause weird
# "Target closed" errors that are very hard to diagnose.
FROM mcr.microsoft.com/playwright:v1.60.0-noble AS runtime

USER pwuser
WORKDIR /home/pwuser/app

# Copy node_modules + compiled dist from the builder.
# We deliberately keep dev dependencies (no `pnpm prune --prod`)
# because tsx — listed in devDependencies — is needed at runtime
# to execute scripts/migrate.ts via `node --import tsx`. The
# alternative (building scripts/ into dist/) would force a
# tsconfig restructure for marginal disk savings.
COPY --from=builder --chown=pwuser:pwuser /build/node_modules ./node_modules
COPY --from=builder --chown=pwuser:pwuser /build/dist ./dist

# Runtime needs these at the workspace root too:
#   - package.json: lets `node --import tsx scripts/migrate.ts`
#     resolve the `tsx` import from local node_modules
#   - migrations/: SQL files the runner reads on startup
#   - scripts/: the migration runner itself
COPY --chown=pwuser:pwuser package.json ./
COPY --chown=pwuser:pwuser migrations ./migrations
COPY --chown=pwuser:pwuser scripts ./scripts

# Service listens on this port inside the container. The host
# port is mapped (or not — the service can stay internal-only
# on the Docker network behind the Directus webhook URL) in
# docker-compose.
EXPOSE 3000

ENV NODE_ENV=production

# Deep healthcheck — /health verifies DB connectivity too
# (see routes/health.ts). Node ≥18 has global `fetch`, so no
# curl/wget dependency in the runtime image.
#
# --start-period=30s gives Chromium time to warm up on the
# first PDF request without flapping the healthcheck status.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist/server.js"]