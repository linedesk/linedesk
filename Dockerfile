# Four images from one file: `api` (Hono server, migrates on start), `web` (Caddy + the built SPA),
# `proxy` (Caddy, the entry point in front of both) and `agent` (LiveKit voice agent, optional).
#   docker build --target api -t linedesk-api .
#   docker build --target web -t linedesk-web .
#   docker build --target proxy -t linedesk-proxy .
#   docker build --target agent -t linedesk-agent .
# The API is the last stage, so a platform that builds this file without a target (Railway, Render,
# Dokku, ...) gets the API, never the empty dev-mode runtime. Keep it last.

FROM node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a AS base
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
    pnpm install --frozen-lockfile --prod --filter "@linedesk/api..." \
    # better-auth lists vitest and drizzle-kit as optional peers; pnpm installs them (with vite,
    # rolldown, esbuild) because the workspace has them. Nothing imports them at runtime.
    && cd node_modules/.pnpm && rm -rf vitest@* @vitest+* vite@* rolldown@* @rolldown+* \
       drizzle-kit@* esbuild@* @esbuild+* @esbuild-kit+* lightningcss* \
       react-dom@* @types+* typescript@* @typescript+* \
    && find . -name "*.map" -delete
COPY . .
# Tests and their config are not part of the image.
RUN rm -rf apps/api/test apps/api/vitest.config.ts && find apps/api packages -name "*.test.ts" -delete

# --- web: build the SPA, serve it with Caddy ---
FROM base AS web-build
COPY --from=manifests /app .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "@linedesk/web..."
COPY . .
# Source maps for Sentry (docs/ci.md, "Sentry source maps"): only the staging and production builds pass the secret
# `sentry_auth_token` and these arguments. The token is mounted for this step alone, never stored in a layer; the maps
# are uploaded and deleted here, so the web image never serves them, also when the upload failed.
ARG SENTRY_ORG
ARG SENTRY_PROJECT
RUN --mount=type=secret,id=sentry_auth_token \
    SENTRY_AUTH_TOKEN="$(cat /run/secrets/sentry_auth_token 2>/dev/null || true)" pnpm --filter @linedesk/web build \
    && find apps/web/dist -name "*.map" -delete

FROM caddy:2-alpine@sha256:003a97808e781aa9f7e75cc2f43d34d461099031faf5e20faefb9f61126836f0 AS web
COPY docker/web.Caddyfile /etc/caddy/Caddyfile
COPY --from=web-build /app/apps/web/dist /srv
# The caddy binary carries cap_net_bind_service, so it binds 80 without root.
RUN adduser -D -H -u 1000 caddy && chown -R caddy:caddy /data /config
USER caddy
HEALTHCHECK --interval=30s --timeout=3s --start-period=30s --start-interval=1s \
  CMD wget -q --spider http://127.0.0.1/ || exit 1

# --- proxy: the entry point. Only the Caddyfile, so the image (and the running container) stays the
# same across updates unless docker/Caddyfile changes. ---
FROM caddy:2-alpine@sha256:003a97808e781aa9f7e75cc2f43d34d461099031faf5e20faefb9f61126836f0 AS proxy
COPY docker/Caddyfile /etc/caddy/Caddyfile
RUN adduser -D -H -u 1000 caddy && chown -R caddy:caddy /data /config
USER caddy

# --- agent: the voice agent worker. Debian, not Alpine: its audio and WebRTC libraries ship glibc binaries. ---
FROM node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS agent-build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app
COPY --from=manifests /app .
RUN --mount=type=cache,id=pnpm-glibc,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter "@linedesk/agent..." \
    # Not needed at runtime: the speech model runtime's macOS and Windows binaries,
    # the TypeScript compiler (an optional peer) and Alpine builds of the image library.
    && cd node_modules/.pnpm && rm -rf onnxruntime-node@*/node_modules/onnxruntime-node/bin/*/darwin \
       onnxruntime-node@*/node_modules/onnxruntime-node/bin/*/win32 \
       typescript@* @typescript+* @img+sharp-*linuxmusl*
COPY . .

FROM node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS agent
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /var/cache/linedesk/greetings && chown node:node /var/cache/linedesk/greetings
WORKDIR /app
COPY --from=agent-build --chown=node:node /app/node_modules ./node_modules
COPY --from=agent-build --chown=node:node /app/apps/agent ./apps/agent
COPY --from=agent-build --chown=node:node /app/packages ./packages
USER node
WORKDIR /app/apps/agent
CMD ["node", "src/worker.ts", "start"]

# --- live: the runtime for dev mode (docker-compose.dev.yml). No code inside: api, web and agent run
# from the source checkout mounted at /app and their node_modules live in a volume (docker/dev-run.mjs),
# so a code change needs no new image. Debian like the agent, so one node_modules fits all three. ---
FROM node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS dev
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/* \
    && corepack enable && corepack prepare pnpm@10.11.0 --activate
WORKDIR /app

# --- api runtime: the default target (see the top) ---
# Node runs the TypeScript sources directly (type stripping), so there is no compile step.
FROM node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a AS api
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
