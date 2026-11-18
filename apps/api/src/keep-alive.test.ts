// The proxy (docker/Caddyfile) must always let go of an idle upstream connection before the upstream closes it: an
// upstream that closes first can do so just as the proxy sends the next request on it, which the proxy answers with
// 502 (EOF), not retried. Node's default keep-alive of 5 s against Caddy's 2 minutes did that (staging, 2026-11-18).
import { createServer, type Server } from 'node:http'
import { connect, type Socket } from 'node:net'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, test } from 'vitest'
import { getRequestListener } from '@hono/node-server'
import {
  configureKeepAlive,
  HEADERS_TIMEOUT_MS,
  HOP_BY_HOP_HEADERS,
  KEEP_ALIVE_TIMEOUT_MS,
  withoutHopByHopHeaders,
} from './keep-alive.ts'

const root = new URL('../../../', import.meta.url)
const read = (path: string) => readFileSync(new URL(path, root), 'utf8')
const caddyfile = read('docker/Caddyfile')

/** Lines without comments, trimmed, empty ones dropped. */
const code = (text: string) =>
  text
    .split('\n')
    .map(line => line.replace(/#.*$/, '').trim())
    .filter(Boolean)

/** The lines of the block that starts at `start` (a line ending in `{`), up to its closing `}`. */
const blockAt = (lines: string[], start: number) => {
  let depth = 0
  for (let i = start; i < lines.length; i++) {
    if (lines[i]!.endsWith('{')) depth++
    if (lines[i] === '}') depth--
    if (depth === 0) return lines.slice(start, i + 1)
  }
  throw new Error(`block without an end: ${lines[start]}`)
}

const seconds = (duration: string) => {
  const match = /^(\d+)(s|m)$/.exec(duration)
  if (!match) throw new Error(`unexpected duration ${duration}`)
  return Number(match[1]) * (match[2] === 'm' ? 60 : 1)
}

describe('idle upstream connections (docker/Caddyfile)', () => {
  const lines = code(caddyfile)

  test('the proxy keeps idle connections shorter than the API does', () => {
    const snippet = blockAt(lines, lines.indexOf('(upstream-keepalive) {'))
    const transport = blockAt(snippet, snippet.indexOf('transport http {'))
    const keepalive = transport.filter(line => line.startsWith('keepalive '))
    expect(keepalive).toHaveLength(1)
    const proxySeconds = seconds(keepalive[0]!.split(/\s+/)[1]!)
    // Room for the time between the API's last byte and the proxy putting the connection back in its pool.
    expect(proxySeconds * 1000 + 10_000).toBeLessThanOrEqual(KEEP_ALIVE_TIMEOUT_MS)
    // The web container is Caddy too: its idle timeout (default 5 minutes) must not be set below the proxy's.
    expect(read('docker/web.Caddyfile')).not.toMatch(/idle_timeout|keepalive/)
  })

  test('every upstream gets that keep-alive', () => {
    const proxies = lines.flatMap((line, at) => (line.startsWith('reverse_proxy') ? [at] : []))
    // The API (public and the voice agent's :3100, one snippet), LiveKit and the web app.
    expect(proxies.length).toBe(3)
    for (const at of proxies) {
      expect(lines[at]!.endsWith('{'), lines[at]).toBe(true)
      expect(blockAt(lines, at), lines[at]).toContain('import upstream-keepalive')
    }
    // Only that one transport setting, so no upstream gets another keep-alive by accident.
    expect(lines.filter(line => line.startsWith('transport ')).length).toBe(1)
  })
})

describe('the API server (apps/api/src/server.ts)', () => {
  test('applies the keep-alive and lets go of it on shutdown', () => {
    const server = read('apps/api/src/server.ts')
    expect(server).toMatch(/configureKeepAlive\(server\)/)
    expect(server).toMatch(/server\.close\([^)]*\)[\s\S]{0,80}stopKeepingAlive\(\)/)
  })

  test('the headers timeout is above the keep-alive timeout', () => {
    expect(HEADERS_TIMEOUT_MS).toBeGreaterThan(KEEP_ALIVE_TIMEOUT_MS)
  })
})

describe('configureKeepAlive', () => {
  let server: Server | undefined
  const sockets: Socket[] = []
  afterEach(() => {
    for (const socket of sockets.splice(0)) socket.destroy()
    server?.closeAllConnections()
    server?.close()
    server = undefined
  })

  /** A server whose responses wait for `release`, with configureKeepAlive applied. */
  const start = async () => {
    const waiting: (() => void)[] = []
    server = createServer((_req, res) => waiting.push(() => res.end('ok')))
    const keepAlive = configureKeepAlive(server)
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as { port: number }
    const release = () => waiting.splice(0).forEach(answer => answer())
    return { ...keepAlive, port, release, waiting }
  }

  /** Sends one request on a new connection; resolves with the response head and when the connection closes. */
  const request = (port: number) => {
    const socket = connect(port, '127.0.0.1')
    sockets.push(socket)
    socket.write('GET / HTTP/1.1\r\nHost: test\r\n\r\n')
    const head = new Promise<string>(resolve => socket.once('data', data => resolve(String(data))))
    const closed = new Promise<void>(resolve => socket.once('close', () => resolve()))
    return { head, closed }
  }

  test('sets the timeouts and announces them', async () => {
    const { port, release, waiting } = await start()
    expect(server!.keepAliveTimeout).toBe(KEEP_ALIVE_TIMEOUT_MS)
    expect(server!.headersTimeout).toBe(HEADERS_TIMEOUT_MS)
    const { head } = request(port)
    await expect.poll(() => waiting.length).toBe(1)
    release()
    expect(await head).toMatch(/Connection: keep-alive/i)
    expect(await head).toContain(`Keep-Alive: timeout=${KEEP_ALIVE_TIMEOUT_MS / 1000}`)
  })

  test('on shutdown, a response still being prepared closes its connection, and the server stops at once', async () => {
    const { port, release, stopKeepingAlive, waiting } = await start()
    const idle = request(port)
    const busy = request(port)
    await expect.poll(() => waiting.length).toBe(2)
    waiting.shift()!() // the first connection answers and is idle from then on
    expect(await idle.head).toMatch(/Connection: keep-alive/i)

    const stopped = new Promise<void>(resolve => server!.close(() => resolve()))
    stopKeepingAlive()
    await idle.closed // closed at once, never reused
    release()
    expect(await busy.head).toMatch(/Connection: close/i)
    await busy.closed
    // Without stopKeepingAlive the busy connection would stay open for the keep-alive timeout.
    await stopped
  })

  test('on shutdown, a response already streaming closes its connection when it ends', async () => {
    const waiting: (() => void)[] = []
    server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.write('streaming')
      waiting.push(() => res.end())
    })
    const { stopKeepingAlive } = configureKeepAlive(server)
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as { port: number }
    const stream = request(port)
    expect(await stream.head).toMatch(/Connection: keep-alive/i)

    const stopped = new Promise<void>(resolve => server!.close(() => resolve()))
    stopKeepingAlive()
    waiting.splice(0).forEach(end => end())
    await stream.closed
    await stopped
  })
})

describe('withoutHopByHopHeaders', () => {
  test('drops the connection headers and those the Connection header names, keeps the rest', () => {
    const headers = withoutHopByHopHeaders({
      connection: 'keep-alive, X-Hop',
      'keep-alive': 'timeout=5',
      'proxy-connection': 'keep-alive',
      te: 'trailers',
      trailer: 'expires',
      'transfer-encoding': 'chunked',
      upgrade: 'h2c',
      'x-hop': '1',
      'content-type': 'application/json',
      'electric-handle': 'abc',
    })
    for (const name of [...HOP_BY_HOP_HEADERS, 'x-hop']) expect(headers.has(name), name).toBe(false)
    expect(Object.fromEntries(headers)).toEqual({ 'content-type': 'application/json', 'electric-handle': 'abc' })
  })

  test('every response passed on from elsewhere goes through it', () => {
    // The shape proxy (Electric's answer) and both MCP endpoints (the SDK sets Connection: keep-alive on SSE).
    expect(read('apps/api/src/app.ts')).toMatch(/const headers = withoutHopByHopHeaders\(res\.headers\)/)
    expect(read('apps/api/src/mcp.ts')).toMatch(/withoutHopByHopHeaders\(res\.headers\)/)
    expect(read('apps/api/src/setup-mcp.ts')).toMatch(/headers: withoutHopByHopHeaders\(res\.headers\)/)
  })

  test('on shutdown, a passed-on Connection: keep-alive no longer keeps the connection open', async () => {
    // As the API serves it (@hono/node-server): an answer copied from an upstream that sent Connection: keep-alive.
    const waiting: (() => void)[] = []
    const upstream = { connection: 'keep-alive', 'keep-alive': 'timeout=5', 'content-type': 'text/plain' }
    const listener = getRequestListener(
      () =>
        new Promise<Response>(resolve =>
          waiting.push(() => resolve(new Response('ok', { headers: withoutHopByHopHeaders(upstream) }))),
        ),
    )
    const server = createServer(listener)
    const { stopKeepingAlive } = configureKeepAlive(server)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as { port: number }
    const socket = connect(port, '127.0.0.1')
    try {
      socket.write('GET / HTTP/1.1\r\nHost: test\r\n\r\n')
      const head = new Promise<string>(resolve => socket.once('data', data => resolve(String(data))))
      const closed = new Promise<void>(resolve => socket.once('close', () => resolve()))
      await expect.poll(() => waiting.length).toBe(1)

      const stopped = new Promise<void>(resolve => server.close(() => resolve()))
      stopKeepingAlive()
      waiting.splice(0).forEach(answer => answer())
      expect(await head).toMatch(/Connection: close/i)
      expect(await head).not.toMatch(/Keep-Alive: timeout=5/i)
      await closed
      await stopped
    } finally {
      socket.destroy()
      server.closeAllConnections()
    }
  })
})
