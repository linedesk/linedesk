import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv, type ServerOptions } from 'vite'

// The API is proxied so the browser sees one origin (session cookie, no CORS).
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '../..', '')
  const api = `http://localhost:${env.PORT ?? 3100}`
  return {
    plugins: [react()],
    // The build's version: when it changes (a new deploy), the local store loads every table afresh.
    define: { 'import.meta.env.VITE_APP_BUILD': JSON.stringify(env.APP_BUILD || new Date().toISOString()) },
    server: {
      port: 5173,
      strictPort: true,
      proxy: { '/api': api, '/v1': api, '/mcp': api },
      ...behindProxy(env.LINEDESK_LIVE_PUBLIC_URL),
    },
  }
})

/**
 * Live mode (docker-compose.live.yml): the dev server runs behind the stack's Caddy at the public URL.
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
