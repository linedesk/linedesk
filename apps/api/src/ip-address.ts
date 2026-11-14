// IP addresses: the one IPv6 parser (also for the per-/64 rate-limit buckets in client-ip.ts), and
// which addresses are not on the public internet, for requests the API makes to URLs that users give
// (webhooks). IPv6 is parsed to its eight groups, so every way of writing an address is the same
// address, and IPv4 addresses embedded in IPv6 (mapped, compatible, NAT64, 6to4) are checked as the
// IPv4 address they reach.
import { type LookupAddress, lookup as dnsLookup } from 'node:dns'
import { isIP } from 'node:net'

function ipv4Octets(ip: string): number[] | null {
  if (isIP(ip) !== 4) return null
  return ip.split('.').map(Number)
}

/** The eight 16-bit groups of an IPv6 address, or null when it is not one. */
export function ipv6Groups(ip: string): number[] | null {
  const text = ip.replace(/^\[|\]$/g, '').split('%')[0]!
  if (isIP(text) !== 6) return null
  let hex = text
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(hex)?.[1]
  if (dotted) {
    const [a, b, c, d] = ipv4Octets(dotted)!
    hex = `${hex.slice(0, -dotted.length)}${((a! << 8) | b!).toString(16)}:${((c! << 8) | d!).toString(16)}`
  }
  const [head, tail] = hex.split('::')
  const left = head ? head.split(':') : []
  const right = tail ? tail.split(':') : []
  const zeros = tail === undefined ? [] : Array<string>(8 - left.length - right.length).fill('0')
  return [...left, ...zeros, ...right].map(g => Number.parseInt(g, 16))
}

function privateIpv4([a, b, c]: number[]): boolean {
  return (
    a === 0 || a === 10 || a === 127 || a! >= 224 ||
    (a === 100 && b! >= 64 && b! < 128) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b! >= 16 && b! < 32) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 198 && (b === 18 || b === 19))
  )
}

const embeddedIpv4 = (high: number, low: number) => [high >> 8, high & 0xff, low >> 8, low & 0xff]

function privateIpv6(g: number[]): boolean {
  const zeroUpTo = (n: number) => g.slice(0, n).every(x => x === 0)
  // ::/96 (IPv4-compatible, also :: and ::1) and ::ffff:0:0/96 (IPv4-mapped): the IPv4 address decides.
  if (zeroUpTo(6) || (zeroUpTo(5) && g[5] === 0xffff)) return privateIpv4(embeddedIpv4(g[6]!, g[7]!))
  // 64:ff9b::/96 (NAT64): the IPv4 address decides; 64:ff9b:1::/48 is for local networks.
  if (g[0] === 0x64 && g[1] === 0xff9b) return g[2] === 1 || privateIpv4(embeddedIpv4(g[6]!, g[7]!))
  // ::ffff:0:0:0/96 (SIIT, IPv4-translated): never a public webhook address.
  if (zeroUpTo(4) && g[4] === 0xffff && g[5] === 0) return true
  // 2002::/16 (6to4): the IPv4 address is in the second and third group.
  if (g[0] === 0x2002) return privateIpv4(embeddedIpv4(g[1]!, g[2]!))
  return (
    (g[0]! & 0xfe00) === 0xfc00 || // unique local
    (g[0]! & 0xffc0) === 0xfe80 || // link-local
    (g[0]! & 0xffc0) === 0xfec0 || // site-local (deprecated, still routed inside some networks)
    (g[0]! & 0xff00) === 0xff00 || // multicast
    (g[0] === 0x2001 && g[1] === 0) || // Teredo (hides an IPv4 address)
    (g[0] === 0x2001 && g[1] === 0xdb8) || // documentation
    (g[0] === 0x100 && zeroUpTo(4)) // discard
  )
}

/** Private, loopback, link-local and other non-public addresses, however they are written. Not an address: true. */
export function isPrivateAddress(ip: string): boolean {
  const v4 = ipv4Octets(ip)
  if (v4) return privateIpv4(v4)
  const v6 = ipv6Groups(ip)
  return v6 ? privateIpv6(v6) : true
}

/**
 * Link-local addresses (169.254.0.0/16, fe80::/10), where clouds answer with the server's own credentials, and the
 * other cloud metadata addresses (AWS over IPv6, Alibaba): never a place the API sends a request to, whoever set the
 * URL. IPv4 addresses embedded in IPv6 count as the IPv4 address they reach.
 */
export function isLinkLocalAddress(ip: string): boolean {
  const v4 = ipv4Octets(ip)
  if (v4) return linkLocalIpv4(v4)
  const g = ipv6Groups(ip)
  if (!g) return false
  const zeroUpTo = (n: number) => g.slice(0, n).every(x => x === 0)
  if (zeroUpTo(6) || (zeroUpTo(5) && g[5] === 0xffff) || (g[0] === 0x64 && g[1] === 0xff9b))
    return linkLocalIpv4(embeddedIpv4(g[6]!, g[7]!))
  if (g[0] === 0x2002) return linkLocalIpv4(embeddedIpv4(g[1]!, g[2]!))
  // fd00:ec2::254: the AWS metadata service over IPv6.
  const awsMetadata = g[0] === 0xfd00 && g[1] === 0xec2 && g.slice(2, 7).every(x => x === 0) && g[7] === 0x254
  return (g[0]! & 0xffc0) === 0xfe80 || awsMetadata
}

function linkLocalIpv4([a, b, c, d]: number[]): boolean {
  return (a === 169 && b === 254) || (a === 100 && b === 100 && c === 100 && d === 200)
}

/** All addresses of a name, as the connection would get them. */
export type Resolve = (hostname: string, callback: (err: Error | null, addresses: LookupAddress[]) => void) => void
export const resolveAll: Resolve = (hostname, callback) => dnsLookup(hostname, { all: true }, callback)

/**
 * A `lookup` for a connection (an undici Agent's `connect.lookup`): resolves the name once and refuses it when any
 * address is `refused`, so the request goes to exactly the address that was checked (no second lookup to rebind).
 * The refusal is an error with code EPRIVATEADDRESS and `message`.
 */
export function checkedLookup(refused: (ip: string) => boolean, message: string, resolve: Resolve = resolveAll) {
  return (hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
    resolve(hostname, (err, addresses) => {
      if (err) return callback(err)
      if (!addresses.length || addresses.some(a => refused(a.address)))
        return callback(Object.assign(new Error(message), { code: 'EPRIVATEADDRESS' }))
      if (options.all) callback(null, addresses)
      else callback(null, addresses[0]!.address, addresses[0]!.family)
    })
  }
}
