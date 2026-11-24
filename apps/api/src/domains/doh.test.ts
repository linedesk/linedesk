// Our own TXT proof over DNS over HTTPS (S5): both resolvers must answer and both hold the value; only the two fixed
// resolvers are ever asked.
import { describe, expect, test } from 'vitest'
import { RESOLVERS, txtAt, txtProven, txtValue } from './doh.ts'

type Records = Record<string, Record<string, string[] | 'nxdomain' | 'servfail' | 'down'>>

/** A fake DoH: per resolver, per name, its TXT values (as DoH JSON quotes them), NXDOMAIN, SERVFAIL or no answer. */
function fakeDoh(records: Records) {
  const asked: string[] = []
  const doFetch = (async (input: string, init: RequestInit) => {
    asked.push(input)
    expect((init.headers as Record<string, string>).accept).toBe('application/dns-json')
    const url = new URL(input)
    const resolver = `${url.origin}${url.pathname}`
    const answer = records[resolver]?.[url.searchParams.get('name')!] ?? []
    if (answer === 'down') throw new TypeError('fetch failed')
    if (answer === 'servfail') return Response.json({ Status: 2 })
    if (answer === 'nxdomain') return Response.json({ Status: 3 })
    return Response.json({
      Status: 0,
      Answer: answer.map(value => ({ name: url.searchParams.get('name'), type: 16, TTL: 300, data: value })),
    })
  }) as typeof fetch
  return { asked, doFetch }
}

const [CF, GOOGLE] = RESOLVERS
const NAME = '_linedesk.app.cascade-it.example'
const WANTED = 'linedesk-verify=abc123'

describe('TXT over DNS over HTTPS', () => {
  test('DoH JSON quoting: one string, split strings, escapes', () => {
    expect(txtValue('"linedesk-verify=abc"')).toBe('linedesk-verify=abc')
    expect(txtValue('"linedesk-verify=" "abc"')).toBe('linedesk-verify=abc')
    expect(txtValue('"say \\"hi\\""')).toBe('say "hi"')
    expect(txtValue('unquoted')).toBe('unquoted')
  })

  test('a match needs both resolvers to hold the value', async () => {
    const both = fakeDoh({ [CF]: { [NAME]: [`"${WANTED}"`] }, [GOOGLE]: { [NAME]: [`"other"`, `"${WANTED}"`] } })
    expect(await txtProven(NAME, WANTED, both.doFetch)).toBe('match')
    expect(both.asked.map(u => new URL(u).origin).sort()).toEqual(['https://cloudflare-dns.com', 'https://dns.google'])
    const one = fakeDoh({ [CF]: { [NAME]: [`"${WANTED}"`] }, [GOOGLE]: { [NAME]: [] } })
    expect(await txtProven(NAME, WANTED, one.doFetch)).toBe('missing')
  })

  test('another token, or none, is missing; NXDOMAIN is an answer', async () => {
    const stale = fakeDoh({
      [CF]: { [NAME]: ['"linedesk-verify=old"'] },
      [GOOGLE]: { [NAME]: ['"linedesk-verify=old"'] },
    })
    expect(await txtProven(NAME, WANTED, stale.doFetch)).toBe('missing')
    const none = fakeDoh({ [CF]: { [NAME]: 'nxdomain' }, [GOOGLE]: { [NAME]: 'nxdomain' } })
    expect(await txtProven(NAME, WANTED, none.doFetch)).toBe('missing')
  })

  test('a resolver that fails or does not answer: unknown, never a match', async () => {
    const down = fakeDoh({ [CF]: { [NAME]: 'down' }, [GOOGLE]: { [NAME]: [`"${WANTED}"`] } })
    expect(await txtProven(NAME, WANTED, down.doFetch)).toBe('unknown')
    const servfail = fakeDoh({ [CF]: { [NAME]: [`"${WANTED}"`] }, [GOOGLE]: { [NAME]: 'servfail' } })
    expect(await txtProven(NAME, WANTED, servfail.doFetch)).toBe('unknown')
    expect(await txtAt(CF, NAME, down.doFetch)).toBeNull()
  })

  test('the name goes only into the query string of the fixed resolvers', async () => {
    const { asked, doFetch } = fakeDoh({})
    await txtProven('_linedesk.evil.example&name=x#', WANTED, doFetch)
    for (const url of asked) {
      expect(RESOLVERS.some(r => url.startsWith(`${r}?`))).toBe(true)
      expect(new URL(url).searchParams.get('name')).toBe('_linedesk.evil.example&name=x#')
    }
  })
})
