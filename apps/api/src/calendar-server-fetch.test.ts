import { describe, expect, it } from 'vitest'
import { calendarServerFetch, calendarServerProblem, calendarServerUrl } from './calendar-server-fetch.ts'
import type { Resolve } from './ip-address.ts'

const resolveTo =
  (address: string): Resolve =>
  (_host, callback) =>
    callback(null, [{ address, family: address.includes(':') ? 6 : 4 }])
const unknown: Resolve = (_host, callback) => callback(new Error('ENOTFOUND'), [])

describe('calendar server addresses', () => {
  it('takes a bare name as https and keeps the path', async () => {
    expect(String(await calendarServerUrl('caldav.icloud.com', {}, resolveTo('17.248.1.1')))).toBe(
      'https://caldav.icloud.com/',
    )
    expect(
      String(
        await calendarServerUrl(' https://dav.example.com:8443/remote.php/dav#x ', {}, resolveTo('93.184.216.34')),
      ),
    ).toBe('https://dav.example.com:8443/remote.php/dav')
  })

  it('refuses plain http, a login in the address, private addresses and names that resolve to them', async () => {
    expect(await calendarServerUrl('http://caldav.example.com', {}, resolveTo('93.184.216.34'))).toBe(
      "Use the server's https address.",
    )
    expect(await calendarServerUrl('https://mike:pw@caldav.example.com', {}, resolveTo('93.184.216.34'))).toMatch(
      /own fields/,
    )
    for (const typed of [
      'https://localhost',
      'https://127.0.0.1',
      'https://[::1]',
      'https://169.254.169.254',
      'https://10.0.0.5',
      'https://radicale.internal',
    ])
      expect(await calendarServerUrl(typed, {}, resolveTo('93.184.216.34')), typed).toMatch(/private|link-local/)
    expect(await calendarServerUrl('dav.example.com', {}, resolveTo('192.168.1.10'))).toMatch(/private/)
    expect(await calendarServerUrl('nowhere.example', {}, unknown)).toBe('nowhere.example could not be found.')
    expect(await calendarServerUrl('not a url', {}, unknown)).toBe('That is not a server address.')
  })

  it('development (WEBHOOK_ALLOW_PRIVATE_URLS) may use a local server over http', async () => {
    const dev = { WEBHOOK_ALLOW_PRIVATE_URLS: 'true' }
    expect(String(await calendarServerUrl('http://radicale:5232/', dev, unknown))).toBe('http://radicale:5232/')
    expect(calendarServerProblem(new URL('ftp://radicale'), dev)).toMatch(/https/)
  })
})

describe('ports and metadata addresses', () => {
  it('only 443 and 8443 on the internet; any port in development', async () => {
    const pub = resolveTo('93.184.216.34')
    expect(String(await calendarServerUrl('https://dav.example.com:8443/', {}, pub))).toBe(
      'https://dav.example.com:8443/',
    )
    expect(await calendarServerUrl('https://dav.example.com:22/', {}, pub)).toMatch(/port 443/)
    expect(
      String(await calendarServerUrl('http://radicale:5232/', { WEBHOOK_ALLOW_PRIVATE_URLS: 'true' }, unknown)),
    ).toBe('http://radicale:5232/')
  })

  it('link-local and cloud metadata addresses are refused even in development', async () => {
    const dev = { WEBHOOK_ALLOW_PRIVATE_URLS: 'true' }
    for (const typed of ['http://169.254.169.254/', 'http://[fd00:ec2::254]/', 'http://[fe80::1]/'])
      expect(await calendarServerUrl(typed, dev, unknown), typed).toMatch(/link-local/)
    expect(await calendarServerUrl('http://metadata.example/', dev, resolveTo('169.254.169.254'))).toMatch(/link-local/)
  })
})

describe('calendarServerFetch', () => {
  const server = new URL('https://caldav.icloud.com/')
  type Sent = { url: string; method?: string; auth: string | null; body?: unknown }
  /** A fake transport: answers in order, records what would have been sent. */
  function transport(...answers: Response[]) {
    const sent: Sent[] = []
    const send = async (url: URL, init: RequestInit) => {
      sent.push({
        url: url.toString(),
        method: init.method,
        auth: new Headers(init.headers).get('authorization'),
        body: init.body,
      })
      return answers.shift() ?? new Response('ok')
    }
    return { sent, send }
  }
  const redirect = (location: string, status = 301) => new Response(null, { status, headers: { location } })
  const init = { method: 'PROPFIND', headers: { authorization: 'Basic c2VjcmV0' }, body: '<propfind/>' }

  it('follows a redirect within the site, keeping method and body', async () => {
    const { sent, send } = transport(
      redirect('https://p42-caldav.icloud.com/123/principal/', 307),
      new Response('<multistatus/>', { status: 207 }),
    )
    const res = await calendarServerFetch(server, { env: {}, send })('https://caldav.icloud.com/', init)
    expect(res.status).toBe(207)
    expect(await res.text()).toBe('<multistatus/>')
    expect(sent).toEqual([
      { url: 'https://caldav.icloud.com/', method: 'PROPFIND', auth: 'Basic c2VjcmV0', body: '<propfind/>' },
      {
        url: 'https://p42-caldav.icloud.com/123/principal/',
        method: 'PROPFIND',
        auth: 'Basic c2VjcmV0',
        body: '<propfind/>',
      },
    ])
  })

  it('never sends the login to another site: not on a redirect, not when asked for one directly', async () => {
    const a = transport(redirect('https://evil.example/collect'))
    await expect(
      calendarServerFetch(server, { env: {}, send: a.send })('https://caldav.icloud.com/', init),
    ).rejects.toThrow(/evil\.example, which is not the server you entered/)
    expect(a.sent.map(s => s.url)).toEqual(['https://caldav.icloud.com/'])
    const b = transport()
    await expect(
      calendarServerFetch(server, { env: {}, send: b.send })('https://evil.example/cal/', init),
    ).rejects.toThrow(/not the server you entered/)
    expect(b.sent).toEqual([])
  })

  it('refuses a redirect to a private address, to plain http and to another port', async () => {
    const own = new URL('https://dav.example.com/')
    for (const location of ['https://10.0.0.5/', 'http://dav.example.com/', 'https://dav.example.com:22/']) {
      const { sent, send } = transport(redirect(location))
      await expect(
        calendarServerFetch(own, { env: {}, send })('https://dav.example.com/', init),
        location,
      ).rejects.toThrow()
      expect(sent, location).toHaveLength(1)
    }
    const ip = new URL('https://10.0.0.5/')
    const { sent, send } = transport()
    await expect(calendarServerFetch(ip, { env: {}, send })('https://10.0.0.5/', init)).rejects.toThrow(/private/)
    expect(sent).toEqual([])
  })

  it('gives up after three redirects and refuses a body over the cap', async () => {
    const loop = transport(...Array.from({ length: 5 }, () => redirect('https://caldav.icloud.com/again')))
    await expect(
      calendarServerFetch(server, { env: {}, send: loop.send })('https://caldav.icloud.com/', init),
    ).rejects.toThrow(/too many redirects/)
    expect(loop.sent).toHaveLength(4)
    const big = transport(new Response('x'.repeat(2_000)))
    await expect(
      calendarServerFetch(server, { env: {}, send: big.send, maxBytes: 1_000 })('https://caldav.icloud.com/', init),
    ).rejects.toThrow(/more than/)
  })

  it('every request has a deadline, also when the caller sends its own signal', async () => {
    let signal: AbortSignal | undefined
    const send = async (_url: URL, i: RequestInit) => {
      signal = i.signal ?? undefined
      return new Response('ok')
    }
    const own = new AbortController()
    await calendarServerFetch(server, { env: {}, send })('https://caldav.icloud.com/', { ...init, signal: own.signal })
    expect(signal).toBeInstanceOf(AbortSignal)
    own.abort()
    expect(signal!.aborted).toBe(true)
  })
})
