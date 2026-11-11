import { describe, expect, it } from 'vitest'
import { callHash, listHash, parseHash } from './useRoute.ts'

const list = { route: 'calls', callId: null, tab: 'you', search: null, member: null, known: true }

describe('route parsing', () => {
  it('keeps the tag filter and the search on a member view, and writes them back', () => {
    const hash = '#calls/member/u_1?q=leak&tag=new_lead'
    expect(parseHash(hash)).toMatchObject({ tab: 'member', member: 'u_1', search: 'leak', tag: 'new_lead', known: true })
    expect(listHash({ tab: 'member', member: 'u_1', search: 'leak', tag: 'new_lead' })).toBe(hash)
    expect(parseHash('#calls/member/u_1?tag=vip')).not.toHaveProperty('tag')
  })

  it('reads the list, a view, a search, a call and the pages from the hash', () => {
    expect(parseHash('')).toEqual(list)
    expect(parseHash('#calls')).toEqual(list)
    expect(parseHash('#calls/done')).toEqual({ ...list, tab: 'done' })
    expect(parseHash('#calls/ai?q=burst%20pipe')).toEqual({ ...list, tab: 'ai', search: 'burst pipe' })
    expect(parseHash('#calls?q=')).toEqual({ ...list, search: '' })
    expect(parseHash('#call/call_demo_02')).toEqual({ ...list, callId: 'call_demo_02' })
    expect(parseHash(callHash('abc'))).toEqual({ ...list, callId: 'abc' })
    expect(parseHash('#assistant')).toEqual({ ...list, route: 'assistant' })
    expect(parseHash('#account')).toEqual({ ...list, route: 'account' })
    expect(parseHash('#admin')).toEqual({ ...list, route: 'admin' })
    expect(parseHash('#admin/users/u1')).toEqual({ ...list, route: 'admin' })
    expect(parseHash('#assistant/hours')).toEqual({ ...list, route: 'assistant' })
    expect(parseHash('#settings/recordings')).toEqual({ ...list, route: 'settings' })
    expect(parseHash('#assistant/as_123abc/hours')).toEqual({ ...list, route: 'assistant' })
  })
  it('keeps the inbox view while a call or another page is open', () => {
    const last = { tab: 'done', search: 'leak' } as const
    expect(parseHash('#call/c1', last)).toMatchObject({ callId: 'c1', tab: 'done', search: 'leak' })
    expect(parseHash('#assistant', last)).toMatchObject({ route: 'assistant', tab: 'done', search: 'leak' })
    expect(parseHash('#calls/spam', last)).toMatchObject({ tab: 'spam', search: null })
  })
  it('marks unknown and inherited names as unknown and shows the inbox', () => {
    for (const hash of ['#nope', '#bogus/route', '#toString', '#constructor', '#__proto__', '#call/', '#calls/nope', '#calls/done/extra', '#team/members', '#assistant/a/b/c', '#assistant/h%20x']) {
      expect(parseHash(hash)).toEqual({ ...list, known: false })
    }
  })
  it('writes the hash for a view and a search', () => {
    expect(listHash({ tab: 'you', search: null })).toBe('#calls')
    expect(listHash({ tab: 'reminders', search: null })).toBe('#calls/reminders')
    expect(listHash({ tab: 'you', search: 'a b' })).toBe('#calls?q=a%20b')
    expect(parseHash(listHash({ tab: 'done', search: '50%' }))).toMatchObject({ tab: 'done', search: '50%' })
  })
})
