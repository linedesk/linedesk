# Three images from one file: `api` (Hono server, migrates on start), `web` (Caddy + the built SPA)
# and `agent` (LiveKit voice agent, optional).
#   docker build --target api -t callfront-api .
#   docker build --target web -t callfront-web .
#   docker build --target agent -t callfront-agent .

FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app

# Only the package manifests and the lockfile, so the install layers below are reused
# until a dependency changes (and new workspace packages need no Dockerfile edit).
FROM base AS manifests
COPY . .
RUN find . -type f ! -name package.json ! -name pnpm-lock.yaml ! -name pnpm-workspace.yaml -delete

# --- api: production dependencies only ---
FROM base AS api-build
COPY --from=manifests /app .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter "@callfront/api..." \
    # better-auth lists vitest and drizzle-kit as optional peers; pnpm installs them (with vite,
    # rolldown, esbuild) because the workspace has them. Nothing imports them at runtime.
    && cd node_modules/.pnpm && rm -rf vitest@* @vitest+* vite@* rolldown@* @rolldown+* \
       drizzle-kit@* esbuild@* @esbuild+* @esbuild-kit+* lightningcss* \
       react-dom@* @types+* typescript@* @typescript+* \
    && find . -name "*.map" -delete
COPY . .
# Tests and their config are not part of the image.
RUN rm -rf apps/api/test apps/api/vitest.config.ts && find apps/api packages -name "*.test.ts" -delete

# Node runs the TypeScript sources directly (type stripping), so there is no compile step.
FROM node:22-alpine AS api
ENV NODE_ENV=production PORT=3100
WORKDIR /app
COPY --from=api-build --chown=node:node /app/node_modules ./node_modules
COPY --from=api-build --chown=node:node /app/apps/api ./apps/api
COPY --from=api-build --chown=node:node /app/packages ./packages
COPY --chown=node:node docker/api-entrypoint.sh ./
USER node
EXPOSE 3100
HEALTHCHECK --interval=5s --timeout=3s --retries=20 \
  CMD wget -qO- http://127.0.0.1:${PORT}/healthz || exit 1
ENTRYPOINT ["/bin/sh", "/app/api-entrypoint.sh"]

# --- web: build the SPA, serve it with Caddy ---
FROM base AS web-build
COPY --from=manifests /app .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "@callfront/web..."
COPY . .
RUN pnpm --filter @callfront/web build

FROM caddy:2-alpine AS web
COPY docker/Caddyfile /etc/caddy/Caddyfile
COPY --from=web-build /app/apps/web/dist /srv
# The caddy binary carries cap_net_bind_service, so it binds 80/443 without root.
RUN adduser -D -H -u 1000 caddy && chown -R caddy:caddy /data /config
USER caddy

# --- agent: the voice agent worker. Debian, not Alpine: its audio and WebRTC libraries ship glibc binaries. ---
FROM node:22-bookworm-slim AS agent-build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app
COPY --from=manifests /app .
RUN --mount=type=cache,id=pnpm-glibc,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter "@callfront/agent..." \
    # Not needed at runtime: the speech model runtime's macOS and Windows binaries,
    # the TypeScript compiler (an optional peer) and Alpine builds of the image library.
    && cd node_modules/.pnpm && rm -rf onnxruntime-node@*/node_modules/onnxruntime-node/bin/*/darwin \
       onnxruntime-node@*/node_modules/onnxruntime-node/bin/*/win32 \
       typescript@* @typescript+* @img+sharp-*linuxmusl*
COPY . .

FROM node:22-bookworm-slim AS agent
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=agent-build --chown=node:node /app/node_modules ./node_modules
COPY --from=agent-build --chown=node:node /app/apps/agent ./apps/agent
COPY --from=agent-build --chown=node:node /app/packages ./packages
USER node
WORKDIR /app/apps/agent
CMD ["node", "src/worker.ts", "start"]
