// The entry point (docker/Caddyfile) sets the browser security headers for the whole site. The
// running stack is checked by hand (PR notes); this keeps the policy from being dropped or loosened.
import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

const caddyfile = readFileSync(new URL('../../../docker/Caddyfile', import.meta.url), 'utf8')
const siteBlock = caddyfile.slice(caddyfile.indexOf('{$SITE_ADDRESS::80} {'))

const headerValue = (name: string) => siteBlock.match(new RegExp(`^\\s*${name} (.+)$`, 'm'))?.[1]?.replace(/^"|"$/g, '')

const cspDirectives = () =>
  new Map(
    (headerValue('Content-Security-Policy') ?? '')
      .split(';')
      .map(d => d.trim().split(/\s+/))
      .filter(parts => parts[0])
      .map(([name, ...values]) => [name!, values]),
  )

describe('security headers (docker/Caddyfile)', () => {
  test('the CSP allows only this origin, plus what the app connects to', () => {
    const csp = cspDirectives()
    expect(csp.get('default-src')).toEqual(["'self'"])
    expect(csp.get('connect-src')).toEqual(["'self'", 'wss:', 'https://openrouter.ai'])
    expect(csp.get('img-src')).toEqual(["'self'", 'data:'])
    expect(csp.get('media-src')).toEqual(["'self'", 'blob:', 'https:'])
    expect(csp.get('frame-ancestors')).toEqual(["'none'"])
    expect(csp.get('base-uri')).toEqual(["'none'"])
    expect(csp.get('object-src')).toEqual(["'none'"])
    // No inline or evaluated script anywhere.
    for (const values of csp.values()) expect(values).not.toContain("'unsafe-inline'")
    for (const values of csp.values()) expect(values).not.toContain("'unsafe-eval'")
  })

  test('no framing, no sniffing, a short referrer, the microphone for this origin only', () => {
    expect(headerValue('X-Frame-Options')).toBe('DENY')
    expect(headerValue('X-Content-Type-Options')).toBe('nosniff')
    expect(headerValue('Referrer-Policy')).toBe('strict-origin-when-cross-origin')
    expect(headerValue('Permissions-Policy')).toBe('microphone=(self), camera=(), geolocation=()')
  })

  test('HSTS only on HTTPS', () => {
    expect(siteBlock).toMatch(/^\s*@https protocol https$/m)
    expect(siteBlock).toMatch(/^\s*header @https Strict-Transport-Security "max-age=\d+"$/m)
    expect(siteBlock).not.toMatch(/^\s*Strict-Transport-Security /m)
  })
})
