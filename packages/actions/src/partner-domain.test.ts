// A partner's own address as typed (S5): what parsePartnerHostname stores, and what it refuses (security review of
// #1172, N-7: `..`, over 253 characters, IP literals; international names as punycode).
import { describe, expect, test } from 'vitest'
import { challengeName, challengeValue, parsePartnerHostname } from './partner-domain.ts'

describe('parsePartnerHostname', () => {
  test('lower-case, without a trailing dot, scheme or slash', () => {
    expect(parsePartnerHostname(' App.Cascade-IT.example. ')).toBe('app.cascade-it.example')
    expect(parsePartnerHostname('https://app.cascade-it.example/')).toBe('app.cascade-it.example')
    expect(parsePartnerHostname('desk.clients.cascade.co.uk')).toBe('desk.clients.cascade.co.uk')
  })

  test('international names are stored as punycode', () => {
    expect(parsePartnerHostname('app.bücher.example')).toBe('app.xn--bcher-kva.example')
  })

  test('refused: no subdomain, IP addresses, ports, paths, wildcards, `..`, too long', () => {
    for (const typed of [
      '',
      'cascade-it.example',
      'localhost',
      '127.0.0.1',
      '10.0.0.1.',
      '0x7f.0.0.1',
      '1.2.3.4.5',
      '[::1]',
      'app.cascade.example:8443',
      'app.cascade.example/path',
      'user@app.cascade.example',
      '*.cascade.example',
      'app..cascade.example',
      '.app.cascade.example',
      'app.cascade.123',
      'app_x.cascade.example',
      '-app.cascade.example',
      'app.cascade.example?x=1',
      `${'a'.repeat(64)}.cascade.example`,
      `${'abcdefghi.'.repeat(25)}example`,
    ])
      expect(parsePartnerHostname(typed), typed).toBeNull()
  })

  test('the TXT record that proves a claim', () => {
    expect(challengeName('app.cascade-it.example')).toBe('_linedesk.app.cascade-it.example')
    expect(challengeValue('ab12')).toBe('linedesk-verify=ab12')
  })
})
