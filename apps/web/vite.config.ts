import { readdirSync, readFileSync } from 'node:fs'
import { sentryVitePlugin } from '@sentry/vite-plugin'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv, type Plugin, type ServerOptions } from 'vite'

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

/**
 * The boot line index.html shows before the app's code has loaded, in every UI language (LIN-371): the catalogs' own
 * "Opening…" (`shell.newWorkspace.opening`, the same words), written into the page as `data-lines`; public/boot-line.js
 * picks the language this browser last used, else its own. No text of its own, so the translations stay in the catalogs.
 */
function bootLines() {
  const locales = new URL('../../packages/i18n/locales/', import.meta.url)
  const lines: Record<string, string> = {}
  for (const locale of readdirSync(locales)) {
    const shell = JSON.parse(readFileSync(new URL(`${locale}/shell.json`, locales), 'utf8')) as Record<string, string>
    if (shell['newWorkspace.opening']) lines[locale] = shell['newWorkspace.opening']
  }
  const attribute = JSON.stringify(lines).replace(/&/g, '&amp;').replace(/'/g, '&#39;')
  return {
    name: 'linedesk-boot-lines',
    transformIndexHtml: (html: string) => html.replace('data-lines=""', `data-lines='${attribute}'`),
  }
}

/**
 * Local development only (`LINEDESK_DEV_AUTO_SIGN_IN=email:password`, e.g. the seeded demo login): a page load without a
 * session signs in as that person on the dev server, so a local stack is always signed in. Only `vite serve` has it; a
 * build never does, nor dev mode on a test server (docker-compose.dev.yml gives its web container
 * LINEDESK_DEV_PUBLIC_URL in the environment; a devbox preview has it only in .env). Signing out signs in again on the
 * next page load; remove the line to see the sign-in screen.
 */
function devAutoSignIn(login: string | undefined, api: string, webOrigin: string | undefined): Plugin | null {
  const at = login?.indexOf(':') ?? -1
  if (!login || at < 1) return null
  const [email, password] = [login.slice(0, at), login.slice(at + 1)]
  return {
    name: 'linedesk-dev-auto-sign-in',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const page = req.method === 'GET' && (req.headers.accept ?? '').includes('text/html')
        // Not on what the proxy forwards to the API (an OAuth callback must keep its own session or none).
        if (!page || /^\/(api|v1|mcp|oauth|\.well-known|shopify\/app)(\/|\?|$)/.test(req.url ?? '')) return next()
        try {
          const cookie = req.headers.cookie ?? ''
          const session = await fetch(`${api}/api/auth/get-session`, { headers: { cookie } })
          if (!session.ok || (await session.json()) !== null) return next() // signed in, or the API is not ready
          const origin = webOrigin || `http://${req.headers.host}`
          const signIn = await fetch(`${api}/api/auth/sign-in/email`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin, 'x-linedesk-entry': 'public' },
            body: JSON.stringify({ email, password }),
          })
          if (signIn.ok) res.setHeader('set-cookie', signIn.headers.getSetCookie())
          else server.config.logger.warn(`LINEDESK_DEV_AUTO_SIGN_IN: sign-in refused (${signIn.status})`)
        } catch (error) {
          server.config.logger.warn(`LINEDESK_DEV_AUTO_SIGN_IN: ${String(error)}`)
        }
        next()
      })
    },
  }
}

/** The framing rules Caddy sends in production (docker/Caddyfile), for the dev and preview servers too. */
const NO_FRAMING = { 'Content-Security-Policy': "frame-ancestors 'none'", 'X-Frame-Options': 'DENY' }

// The API is proxied so the browser sees one origin (session cookie, no CORS).
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '../..', '')
  const api = `http://localhost:${env.PORT ?? 3100}`
  // From the build's own environment only, never from .env: a token kept there for the Sentry API must not upload.
  const sentry = sentrySourceMaps(process.env)
  return {
    plugins: [
      react(),
      bootLines(),
      process.env.LINEDESK_DEV_PUBLIC_URL ? null : devAutoSignIn(env.LINEDESK_DEV_AUTO_SIGN_IN, api, env.WEB_ORIGIN),
      sentry,
    ].filter(p => p !== null),
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
      // No page of the app in another site's frame (the OAuth consent page above all), as Caddy sends in production.
      headers: NO_FRAMING,
      // Marked public, as Caddy does: a request through the dev server (or a tunnel to it) never counts as the
      // agent's internal one, so the agent token is refused on it (apps/api/src/context.ts).
      proxy: Object.fromEntries(
        // /shopify/app: the Shopify app's embedded page, which the API serves (apps/api/src/shopify-embedded.ts).
        ['/api', '/v1', '/mcp', '/oauth', '/.well-known', '/shopify/app'].map(path => [
          path,
          { target: api, headers: { 'x-linedesk-entry': 'public' } },
        ]),
      ),
      ...behindProxy(env.LINEDESK_DEV_PUBLIC_URL),
    },
    preview: { headers: NO_FRAMING },
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
