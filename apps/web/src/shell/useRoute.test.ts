import { describe, expect, it } from 'vitest'
import { knownSectionHash } from '../ui/SettingsLayout.tsx'
import {
  callHash,
  linkNotice,
  linkWorkspace,
  linkWorkspaceTarget,
  listHash,
  movedHash,
  parseHash,
  withoutLinkWorkspace,
} from './useRoute.ts'

const list = { route: 'calls', callId: null, tab: 'you', search: null, member: null, known: true }

describe('route parsing', () => {
  it('keeps the search on a member view, and writes it back', () => {
    const hash = '#calls/member/u_1?q=leak'
    expect(parseHash(hash)).toMatchObject({ tab: 'member', member: 'u_1', search: 'leak', known: true })
    expect(listHash({ tab: 'member', member: 'u_1', search: 'leak' })).toBe(hash)
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
    for (const hash of [
      '#nope',
      '#bogus/route',
      '#toString',
      '#constructor',
      '#__proto__',
      '#call/',
      '#calls/nope',
      '#calls/done/extra',
      '#team/members',
      '#assistant/a/b/c',
      '#assistant/h%20x',
    ]) {
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

describe('the workspace a link is for', () => {
  it('reads ws= from the hash, next to a search, and nothing else', () => {
    expect(linkWorkspace('#call/call_1?ws=ws_1')).toBe('ws_1')
    expect(linkWorkspace('#calls?q=leak&ws=ws_1')).toBe('ws_1')
    expect(linkWorkspace('#settings/phone?ws=a%20b%26c')).toBe('a b&c')
    expect(linkWorkspace('#settings/phone')).toBeNull()
    expect(linkWorkspace('#calls?q=ws=1')).toBeNull()
    expect(linkWorkspace('#call/call_1?ws=')).toBeNull()
    expect(linkWorkspace('')).toBeNull()
  })

  it('drops it and keeps the rest of the hash', () => {
    expect(withoutLinkWorkspace('#call/call_1?ws=ws_1')).toBe('#call/call_1')
    expect(withoutLinkWorkspace('#calls?q=leak&ws=ws_1')).toBe('#calls?q=leak')
    expect(withoutLinkWorkspace('#settings/phone')).toBe('#settings/phone')
  })

  it('does not change where a link leads', () => {
    expect(parseHash('#call/call_1?ws=ws_1')).toEqual(parseHash('#call/call_1'))
    expect(parseHash('#settings/phone?ws=ws_1')).toEqual(parseHash('#settings/phone'))
    expect(parseHash('#settings/notifications?ws=ws_1')).toEqual(parseHash('#settings/notifications'))
    expect(parseHash('#calls?ws=ws_1')).toEqual(parseHash('#calls'))
    expect(parseHash('#calls?q=leak&ws=ws_1')).toEqual(parseHash('#calls?q=leak'))
  })

  const mine = [
    { id: 'ws_1', name: 'Brightwater Plumbing & Heating' },
    { id: 'ws_2', name: 'Brightwater Rentals' },
  ]

  it('stays in this workspace, switches to another of the member, or says there is no access', () => {
    expect(linkWorkspaceTarget('ws_1', 'ws_1', mine)).toEqual({ kind: 'here' })
    expect(linkWorkspaceTarget('ws_2', 'ws_1', mine)).toEqual({ kind: 'switch', workspace: mine[1] })
    expect(linkWorkspaceTarget('ws_9', 'ws_1', mine)).toEqual({ kind: 'noAccess' })
    expect(linkWorkspaceTarget('ws_2', 'ws_1', undefined)).toEqual({ kind: 'noAccess' })
    // Offline the session cannot switch: the inbox names the workspace instead.
    expect(linkWorkspaceTarget('ws_2', 'ws_1', mine, true)).toEqual({ kind: 'elsewhere', workspace: mine[1] })
  })

  it('says why a link did not open here', () => {
    expect(linkNotice({ kind: 'here' })).toBeNull()
    expect(linkNotice({ kind: 'switch', workspace: mine[1]! })).toBeNull()
    expect(linkNotice({ kind: 'noAccess' })).toMatch(/don't have access/)
    expect(linkNotice({ kind: 'elsewhere', workspace: mine[1]! })).toContain('Brightwater Rentals')
  })
})

describe('settings sections', () => {
  const sections = [{ id: 'notifications', label: 'Notifications' }, { id: 'phone', label: 'Phone numbers' }]

  it('sends #settings/assistant to the assistant', () => {
    expect(movedHash('#settings/assistant')).toBe('#assistant')
  })

  it('an unknown section shows the first one, and the address says so', () => {
    expect(knownSectionHash('settings', sections, '#settings/nope?x=1')).toBe('#settings/notifications?x=1')
    expect(knownSectionHash('settings', sections, '#settings/phone')).toBeNull()
    expect(knownSectionHash('settings', sections, '#settings')).toBeNull()
    expect(knownSectionHash('settings', sections, '#assistant/a1/hours')).toBeNull()
  })
})
