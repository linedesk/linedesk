// Who is asking, for rate limits: the address of the connection, or, when that is a proxy listed
// in TRUSTED_PROXIES (addresses or IPv4 ranges: Caddy, the Vite dev proxy), the last address before our proxies in
// X-Forwarded-For. Headers from anyone else are ignored, so a client cannot pick its own bucket.
import { getConnInfo } from '@hono/node-server/conninfo'
import { isIP } from 'node:net'
import type { Context } from 'hono'

/** The header the API sets for Better Auth; any value a client sends in it is replaced. */
export const CLIENT_IP_HEADER = 'x-linedesk-client-ip'

const plain = (ip: string) => ip.trim().replace(/^::ffff:/, '')

export const trustedProxies = (env: Record<string, string | undefined> = process.env) =>
  (env.TRUSTED_PROXIES ?? '').split(',').map(plain).filter(Boolean)

const ipv4 = (ip: string) => {
  const parts = ip.split('.').map(Number)
  return parts.length === 4 && parts.every(n => Number.isInteger(n) && n >= 0 && n <= 255)
    ? parts.reduce((a, n) => a * 256 + n, 0)
    : null
}

/** An exact address, or an IPv4 range like `172.16.0.0/12`. */
function matches(ip: string, entry: string): boolean {
  const [base, bits] = entry.split('/')
  if (bits === undefined) return ip === base
  const [a, b, size] = [ipv4(ip), ipv4(base!), Number(bits)]
  if (a === null || b === null || !Number.isInteger(size) || size < 0 || size > 32) return false
  const block = 2 ** (32 - size)
  return Math.floor(a / block) === Math.floor(b / block)
}

const isTrusted = (ip: string, trusted: string[]) => trusted.some(entry => matches(ip, entry))

/** `socket` is the connection's address; `forwardedFor` the X-Forwarded-For header, if any. */
export function resolveClientIp(
  socket: string | undefined,
  forwardedFor: string | undefined,
  trusted: string[],
): string | null {
  if (!socket) return null
  const direct = plain(socket)
  if (!isTrusted(direct, trusted)) return direct
  const chain = (forwardedFor ?? '').split(',').map(plain).filter(Boolean)
  for (let i = chain.length - 1; i >= 0; i--) if (!isTrusted(chain[i]!, trusted)) return chain[i]!
  return direct
}

function socketAddress(c: Context): string | undefined {
  try {
    return getConnInfo(c).remote.address
  } catch {
    return undefined // not running in the Node server (a test without a socket)
  }
}

/** The eight groups of an IPv6 address (hex, no leading zeros), or null when it is not one. */
function ipv6Groups(ip: string): string[] | null {
  if (isIP(ip) !== 6) return null
  let text = ip.split('%')[0]!
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)?.[1]
  if (dotted) {
    const n = ipv4(dotted)!
    text = `${text.slice(0, -dotted.length)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`
  }
  const [head, tail] = text.split('::')
  const left = head ? head.split(':') : []
  const right = tail ? tail.split(':') : []
  const zeros = tail === undefined ? [] : Array<string>(8 - left.length - right.length).fill('0')
  return [...left, ...zeros, ...right].map(g => Number.parseInt(g, 16).toString(16))
}

/**
 * The bucket a per-address limit counts in: an IPv4 address, or an IPv6 address's /64 network
 * (one customer usually holds a whole /64, so single addresses would let them rotate past a limit).
 */
export function addressBucket(ip: string | null): string {
  if (!ip) return 'unknown'
  const groups = ipv6Groups(ip)
  return groups ? `${groups.slice(0, 4).join(':')}::/64` : ip
}

/** The address the request comes from (see the top of this file), or null without a socket. */
export const clientIpOf = (c: Context) =>
  resolveClientIp(socketAddress(c), c.req.header('x-forwarded-for'), trustedProxies())

/** The request Better Auth sees: our client IP header, never the client's own. */
export function withClientIp(c: Context): Request {
  const headers = new Headers(c.req.raw.headers)
  headers.delete(CLIENT_IP_HEADER)
  const ip = clientIpOf(c)
  if (ip) headers.set(CLIENT_IP_HEADER, ip)
  return new Request(c.req.raw, { headers })
}
