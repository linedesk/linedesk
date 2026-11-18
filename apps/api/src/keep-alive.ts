// How long the API keeps an idle connection open, and how it lets go of them when it stops.
//
// The proxy (docker/Caddyfile) keeps idle connections to the API for `keepalive 60s` and reuses them. Node's default
// is 5 s: the API closed a connection the proxy was just sending the next request on, the proxy got EOF and answered
// 502 (staging, 2026-11-18; a request that reached the API is not retried, docker/Caddyfile). So the API waits
// longer than the proxy: the proxy always lets go of an idle connection first (caddy-upstreams.test.ts).
import type { Server, ServerResponse } from 'node:http'

/** Above the proxy's 60 s, with room for the time between the API's last byte and the proxy putting it back. */
export const KEEP_ALIVE_TIMEOUT_MS = 75_000
/** Node needs the headers timeout above the keep-alive timeout, or it can close a connection a request is on. */
export const HEADERS_TIMEOUT_MS = KEEP_ALIVE_TIMEOUT_MS + 1_000

/**
 * Sets the timeouts above on `server`. The returned `stopKeepingAlive` is for the shutdown: every response from then
 * on (also those still being prepared) closes its connection, so the proxy sends nothing more on it, and connections
 * idle now are closed. Without it a connection that answered during the shutdown would stay open until the process
 * exits, and the proxy could send the next request on it.
 */
export function configureKeepAlive(server: Server) {
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS
  server.headersTimeout = HEADERS_TIMEOUT_MS
  const open = new Set<ServerResponse>()
  let stopping = false
  const closeAfter = (res: ServerResponse) => {
    // Before the headers: Node sends `Connection: close` and closes the connection after this response.
    if (!res.headersSent) res.shouldKeepAlive = false
    // Already sending (a sync stream): close the connection once it is idle.
    else res.once('finish', () => setImmediate(() => server.closeIdleConnections()))
  }
  server.on('request', (_req, res: ServerResponse) => {
    if (stopping) return closeAfter(res)
    open.add(res)
    res.once('close', () => open.delete(res))
  })
  return {
    stopKeepingAlive() {
      stopping = true
      for (const res of open) closeAfter(res)
      open.clear()
      server.closeIdleConnections()
    },
  }
}
