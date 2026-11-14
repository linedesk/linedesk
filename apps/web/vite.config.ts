import { readFileSync } from 'node:fs'
import { sentryVitePlugin } from '@sentry/vite-plugin'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv, type ServerOptions } from 'vite'

/** The newest database migration: synced rows kept from an older schema may miss its columns. */
function latestMigration(): string {
  const journal = JSON.parse(
    readFileSync(new URL('../../packages/db/migrations/meta/_journal.json', import.meta.url), 'utf8'),
  )
  return (journal as { entries: { tag: string }[] }).entries.at(-1)?.tag ?? 'none'
}

/**
 * Readable stacks in Sentry (docs/ci.md, "Sentry source maps"): only when the build is given a token, an
 * organization and a project (the staging and production image builds), the build writes source maps without a
 * link to them in the scripts, uploads them to Sentry with debug IDs and deletes them. Any other build (local,
 * pull requests, self-hosters) has none, as before.
 */
function sentrySourceMaps(env: NodeJS.ProcessEnv) {
  const { SENTRY_AUTH_TOKEN: authToken, SENTRY_ORG: org, SENTRY_PROJECT: project } = env
  if (!authToken || !org || !project) return null
  return sentryVitePlugin({
    authToken,
    org,
    project,
    url: env.SENTRY_URL || undefined,
    telemetry: false,
    // Matched by debug ID, not by release: no release is created, and the app keeps naming its own (VITE_APP_BUILD).
    release: { create: false, finalize: false, inject: false },
    sourcemaps: { filesToDeleteAfterUpload: ['./dist/**/*.map'] },
  })
}

// The API is proxied so the browser sees one origin (session cookie, no CORS).
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '../..', '')
  const api = `http://localhost:${env.PORT ?? 3100}`
  // From the build's own environment only, never from .env: a token kept there for the Sentry API must not upload.
  const sentry = sentrySourceMaps(process.env)
  return {
    plugins: sentry ? [react(), sentry] : [react()],
    build: { sourcemap: sentry ? 'hidden' : false },
    // The build's version: names the service worker's cache (src/serviceWorker.ts), one per deploy.
    // The schema: when a deploy brings a migration, the local store loads every table once more (storeCache.ts).
    define: {
      'import.meta.env.VITE_APP_BUILD': JSON.stringify(env.APP_BUILD || new Date().toISOString()),
      'import.meta.env.VITE_SCHEMA_VERSION': JSON.stringify(latestMigration()),
    },
    server: {
      port: 5173,
      strictPort: true,
      // Marked public, as Caddy does: a request through the dev server (or a tunnel to it) never counts as the
      // agent's internal one, so the agent token is refused on it (apps/api/src/context.ts).
      proxy: Object.fromEntries(
        ['/api', '/v1', '/mcp'].map(path => [path, { target: api, headers: { 'x-linedesk-entry': 'public' } }]),
      ),
      ...behindProxy(env.LINEDESK_DEV_PUBLIC_URL),
    },
  }
})

/**
 * Dev mode (docker-compose.dev.yml): the dev server runs behind the stack's Caddy at the public URL.
 * The browser opens the hot-reload WebSocket on that URL's host, scheme and port (not the dev server's
 * own), and the dev server accepts requests for that host name. It serves only what the web app is
 * built from (no server code, no .env), since the URL is public.
 */
function behindProxy(publicUrl: string | undefined): ServerOptions {
  if (!publicUrl) return {}
  const url = new URL(publicUrl)
  const secure = url.protocol === 'https:'
  return {
    host: '0.0.0.0',
    port: 80,
    allowedHosts: [url.hostname],
    fs: { strict: true, allow: ['.', '../../packages', '../../node_modules'] },
    hmr: {
      protocol: secure ? 'wss' : 'ws',
      host: url.hostname,
      clientPort: Number(url.port || (secure ? 443 : 80)),
    },
  }
}
