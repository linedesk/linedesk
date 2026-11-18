// Partners' own addresses (white-label S5, PR 5.0): docker/Caddyfile serves them in a second site block, switched on
// by LINEDESK_PARTNER_SITE=on (docker-compose.cloudflare.yml). It must serve exactly what the install's own site serves,
// through the public entry: a client must never reach the API as `internal` (which skips the host check and accepts the
// voice agent's tokens, apps/api/src/request-host.ts and context.ts) by sending X-Linedesk-Entry itself.
import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

const root = new URL('../../../', import.meta.url)
const caddyfile = readFileSync(new URL('docker/Caddyfile', root), 'utf8')
const cloudflare = readFileSync(new URL('docker-compose.cloudflare.yml', root), 'utf8')

/** The lines of the block whose first line is `head`, up to its closing brace. In a Caddyfile a block opens with `{` at
 * the end of a line and closes with `}` alone on its line; placeholders like `{args[0]}` never do either. */
const block = (head: string) => {
  const lines = caddyfile.split('\n')
  const first = lines.findIndex(line => line.trim() === head)
  expect(first, head).toBeGreaterThanOrEqual(0)
  let depth = 0
  for (let i = first; i < lines.length; i++) {
    const line = lines[i]!.replace(/#.*$/, '').trim()
    if (line.endsWith('{')) depth++
    if (line === '}') depth--
    if (depth === 0) return lines.slice(first, i + 1).join('\n')
  }
  throw new Error(`no end for ${head}`)
}

/** Lines without comments, trimmed, empty ones dropped. */
const code = (text: string) =>
  text
    .split('\n')
    .map(line => line.replace(/#.*$/, '').trim())
    .filter(Boolean)

describe('partner site (docker/Caddyfile)', () => {
  test('the install’s own site and the partner site import the same routes', () => {
    expect(code(block('{$SITE_ADDRESS::80} {'))).toEqual([
      '{$SITE_ADDRESS::80} {',
      'import tls-{$LINEDESK_TLS:automatic}',
      'import app-routes',
      '}',
    ])
    expect(code(block('(partner-site-on) {'))).toEqual([
      '(partner-site-on) {',
      ':443 {',
      'import tls-{$LINEDESK_TLS:automatic}',
      'import app-routes',
      '}',
      '}',
    ])
    expect(code(block('(partner-site-off) {'))).toEqual(['(partner-site-off) {', '}'])
    expect(caddyfile).toMatch(/^import partner-site-\{\$LINEDESK_PARTNER_SITE:off\}$/m)
  })

  test('every API route of the shared routes goes through the public entry, never the internal one', () => {
    const routes = code(block('(app-routes) {'))
    const apiImports = routes.filter(line => /^import api\b/.test(line))
    expect(apiImports).toEqual(['import api public'])
    // No other way to the API or a header of its own: only the (api) snippet sets X-Linedesk-Entry.
    expect(routes.join('\n')).not.toMatch(/X-Linedesk-Entry|:3100|\{\$API_HOST/i)
    // The internal entry is the unpublished :3100 listener only.
    expect(caddyfile.match(/import api internal/g)).toHaveLength(1)
    expect(code(block(':3100 {'))).toEqual([':3100 {', 'import api internal', '}'])
  })

  test('the API snippet replaces any X-Linedesk-Entry the client sent', () => {
    const api = code(block('(api) {'))
    expect(api).toContain('header_up X-Linedesk-Entry {args[0]}')
  })

  test('Authenticated Origin Pulls: origin-pull checks Cloudflare’s client certificate on every site', () => {
    expect(code(block('(tls-origin-pull) {'))).toEqual([
      '(tls-origin-pull) {',
      'tls /etc/caddy/certs/origin.pem /etc/caddy/certs/origin.key {',
      'client_auth {',
      'mode require_and_verify',
      'trust_pool file /etc/caddy/certs/origin-pull-ca.pem',
      '}',
      '}',
      '}',
    ])
  })

  test('behind Cloudflare the partner site is on, and LINEDESK_ORIGIN_PULL picks origin-pull', () => {
    expect(cloudflare).toMatch(/^\s+LINEDESK_PARTNER_SITE: \$\{LINEDESK_PARTNER_SITE:-on\}$/m)
    expect(cloudflare).toMatch(/^\s+LINEDESK_TLS: origin\$\{LINEDESK_ORIGIN_PULL:\+-pull\}$/m)
  })
})
