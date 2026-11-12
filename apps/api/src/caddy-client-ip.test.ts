// The visitor's address for rate limits and logs (client-ip.ts) comes from the X-Forwarded-For that the proxy
// sends. Caddy (docker/Caddyfile) must replace it with the client as it determined it, from trusted proxies only;
// behind Cloudflare (docker-compose.cloudflare.yml) that is CF-Connecting-IP from Cloudflare's addresses.
import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'

const root = new URL('../../../', import.meta.url)
const caddyfile = readFileSync(new URL('docker/Caddyfile', root), 'utf8')
const cloudflare = readFileSync(new URL('docker-compose.cloudflare.yml', root), 'utf8')

test('the API gets the client Caddy determined as the only X-Forwarded-For hop', () => {
  const api = caddyfile.slice(caddyfile.indexOf('(api) {'), caddyfile.indexOf(':3100 {'))
  expect(api).toContain('header_up X-Forwarded-For {client_ip}')
})

test('forwarded headers are read only from trusted proxies, right to left, and none are trusted by default', () => {
  expect(caddyfile).toMatch(/trusted_proxies static \{\$LINEDESK_TRUSTED_PROXY_RANGES\}/)
  expect(caddyfile).toContain('trusted_proxies_strict')
  expect(caddyfile).toContain('client_ip_headers {$LINEDESK_CLIENT_IP_HEADERS:X-Forwarded-For}')
  expect(caddyfile).toContain('import tls-{$LINEDESK_TLS:automatic}')
})

test('behind Cloudflare: only its ranges are trusted, the visitor comes from CF-Connecting-IP, the origin certificate is served', () => {
  expect(cloudflare).toContain('LINEDESK_CLIENT_IP_HEADERS: CF-Connecting-IP')
  expect(cloudflare).toContain('LINEDESK_TLS: origin')
  const ranges = cloudflare.slice(
    cloudflare.indexOf('LINEDESK_TRUSTED_PROXY_RANGES:'),
    cloudflare.indexOf('LINEDESK_CLIENT_IP_HEADERS'),
  )
  for (const range of ['173.245.48.0/20', '104.16.0.0/13', '172.64.0.0/13', '2606:4700::/32'])
    expect(ranges).toContain(range)
  // No private or catch-all range, which would let anyone inside it name the client.
  expect(ranges).not.toMatch(/\b(10\.|172\.16\.|192\.168\.|0\.0\.0\.0\/0|::\/0)/)
})
