import { expect, test } from 'vitest'
import {
  adminGroups,
  adminHash,
  adminSections,
  billingTab,
  isListPlace,
  movedPlace,
  nextSection,
  parseAdminHash,
  placeUp,
  providersTarget,
  sectionIndexOfKey,
  sectionKey,
  tabSwitchesSection,
} from './route.ts'

test('admin hashes name a section and optionally a row', () => {
  expect(parseAdminHash('#admin')).toEqual({ section: 'overview', id: null })
  expect(parseAdminHash('#admin/users')).toEqual({ section: 'users', id: null })
  expect(parseAdminHash('#admin/users/u%2F1')).toEqual({ section: 'users', id: 'u/1' })
  expect(parseAdminHash('#admin/nothing/1')).toEqual({ section: 'overview', id: null })
  expect(adminHash({ section: 'users', id: 'u/1' })).toBe('#admin/users/u%2F1')
  expect(adminHash({ section: 'server', id: null })).toBe('#admin/server')
  // System was split up (LIN-693): its old address opens Server.
  expect(parseAdminHash('#admin/system')).toEqual({ section: 'server', id: null })
})

test('Providers: a group scrolls, a provider opens its dialog, old category and checklist links find their group', () => {
  expect(parseAdminHash('#admin/providers/call-audio')).toEqual({ section: 'providers', id: 'call-audio' })
  expect(providersTarget('call-audio')).toEqual({ group: 'call-audio' })
  expect(providersTarget('email')).toEqual({ group: 'email' })
  expect(providersTarget('deepgram')).toEqual({ provider: 'deepgram' })
  expect(providersTarget('stt')).toEqual({ group: 'answering' })
  expect(providersTarget('sign_in')).toEqual({ group: 'sign-in' })
  expect(providersTarget('livekit')).toEqual({ group: 'call-audio' })
  expect(providersTarget('ai')).toEqual({ group: 'answering' })
  expect(providersTarget('nothing')).toBeNull()
  expect(providersTarget(null)).toBeNull()
})

test('old addresses land where their things moved (LIN-693)', () => {
  const providers = (id: string | null) => ({ section: 'providers' as const, id })
  // Stripe and the bot check are connected under Providers again; Billing › Sign-up is the Sign-up section.
  expect(movedPlace(providers('billing'))).toBeNull()
  expect(movedPlace(providers('stripe'))).toBeNull()
  expect(movedPlace(providers('bot_check'))).toBeNull()
  expect(movedPlace({ section: 'billing', id: 'signup' })).toEqual({ section: 'signup', id: null })
  expect(movedPlace({ section: 'billing', id: 'stripe' })).toBeNull()
  // Call audio is a status: under Server.
  expect(movedPlace(providers('call-audio'))).toEqual({ section: 'server', id: null })
  expect(movedPlace(providers('livekit'))).toEqual({ section: 'server', id: null })
  expect(movedPlace(providers('email'))).toBeNull()
  expect(movedPlace(providers(null))).toBeNull()
  expect(billingTab('stripe')).toBe('stripe')
  expect(billingTab('signup')).toBeNull()
})

test("Settings' old tab addresses open the sections they became", () => {
  expect(parseAdminHash('#admin/settings')).toEqual({ section: 'calls', id: null })
  expect(parseAdminHash('#admin/settings/numbers')).toEqual({ section: 'numbers', id: null })
  expect(parseAdminHash('#admin/settings/signup')).toEqual({ section: 'signup', id: null })
  expect(parseAdminHash('#admin/settings/integrations')).toEqual({ section: 'tools', id: null })
  expect(parseAdminHash('#admin/settings/constructor')).toEqual({ section: 'calls', id: null })
  expect(isListPlace({ section: 'signup', id: null })).toBe(true)
})

test('Tab and Shift-Tab go round the sections', () => {
  expect(nextSection('overview', false)).toBe('usage')
  expect(nextSection('overview', true)).toBe('audit')
  expect(nextSection('partners', false)).toBe('signup')
  expect(nextSection('billing', false)).toBe('prompt')
  expect(nextSection('tools', false)).toBe('branding')
  expect(nextSection('audit', false)).toBe('overview')
})

test('Tab switches sections only from the page body, never from a control', () => {
  const doc = {} as Document
  const body = { ownerDocument: doc } as unknown as Element
  Object.assign(doc, { body, documentElement: { ownerDocument: doc } })
  const button = { ownerDocument: doc } as unknown as Element
  expect(tabSwitchesSection(null)).toBe(true)
  expect(tabSwitchesSection(body)).toBe(true)
  expect(tabSwitchesSection(button)).toBe(false)
})

test('section names and descriptions are message keys, so every language shows its own', async () => {
  const { enMessages } = await import('@linedesk/i18n')
  for (const section of adminSections) {
    expect(enMessages[section.label], section.id).toBeTruthy()
    if (section.description) expect(enMessages[section.description], section.id).toBeTruthy()
  }
  expect(enMessages[adminSections.find(s => s.id === 'audit')!.label]).toBe('Audit log')
  // The nav's groups: each opens with its first section, in order.
  expect(adminSections.filter(s => 'group' in s).map(s => [s.id, enMessages[adminGroups[s.group]]])).toEqual([
    ['overview', 'Activity'],
    ['workspaces', 'Customers'],
    ['prompt', 'Assistant'],
    ['branding', 'System'],
  ])
})

test('digits 1 to 9, then 0, open the first ten sections in order; the ones after Prompt have none', () => {
  const keys = adminSections.slice(0, 10).map((_, i) => sectionKey(i))
  expect(keys).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'])
  for (const [i] of keys.entries()) expect(sectionIndexOfKey(sectionKey(i)!)).toBe(i)
  expect(adminSections[9]!.id).toBe('prompt')
  expect(adminSections[10]!.id).toBe('calls')
  expect(sectionKey(10)).toBeUndefined()
  expect(parseAdminHash('#admin/billing/bill_1')).toEqual({ section: 'billing', id: 'bill_1' })
})

test('Billing sections have their own address; anything else under Billing is a bill', () => {
  expect(billingTab(null)).toBe('overview')
  expect(billingTab('rules')).toBe('rules')
  expect(billingTab('bill_1')).toBeNull()
  expect(isListPlace({ section: 'billing', id: 'events' })).toBe(true)
  expect(isListPlace({ section: 'billing', id: 'bill_1' })).toBe(false)
  // Esc and the crumb go one step up: a bill to the bills, a section to Billing, Billing nowhere.
  expect(placeUp({ section: 'billing', id: 'bill_1' })).toEqual({ section: 'billing', id: 'bills' })
  expect(placeUp({ section: 'billing', id: 'rules' })).toEqual({ section: 'billing', id: null })
  expect(placeUp({ section: 'billing', id: null })).toBeNull()
  expect(placeUp({ section: 'workspaces', id: 'ws1' })).toEqual({ section: 'workspaces', id: null })
})
