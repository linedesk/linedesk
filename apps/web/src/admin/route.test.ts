import { expect, test } from 'vitest'
import {
  adminHash,
  adminSections,
  billingTab,
  isListPlace,
  movedHash,
  nextSection,
  parseAdminHash,
  placeUp,
  providersTarget,
  sectionIndexOfKey,
  sectionKey,
  stripeEventsHref,
  tabSwitchesSection,
  workspaceViewOfHash,
  workspacesHref,
} from './route.ts'

test('admin hashes name a section and optionally a row', () => {
  expect(parseAdminHash('#admin')).toEqual({ section: 'overview', id: null })
  expect(parseAdminHash('#admin/users')).toEqual({ section: 'users', id: null })
  expect(parseAdminHash('#admin/users/u%2F1')).toEqual({ section: 'users', id: 'u/1' })
  expect(parseAdminHash('#admin/nothing/1')).toEqual({ section: 'overview', id: null })
  expect(adminHash({ section: 'users', id: 'u/1' })).toBe('#admin/users/u%2F1')
  expect(adminHash({ section: 'features', id: null })).toBe('#admin/features')
  expect(parseAdminHash('#admin/workspaces?view=usage')).toEqual({ section: 'workspaces', id: null })
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

test('old addresses land where their things moved (LIN-693, LIN-747, the nav groups)', () => {
  expect(movedHash('#admin/usage')).toBe('#admin/workspaces?view=usage')
  expect(movedHash('#admin/onboarding')).toBe('#admin/workspaces?view=at-risk')
  expect(movedHash('#admin/signup')).toBe('#admin/access')
  expect(movedHash('#admin/calls')).toBe('#admin/features')
  expect(movedHash('#admin/numbers')).toBe('#admin/features')
  expect(movedHash('#admin/tools')).toBe('#admin/features')
  expect(movedHash('#admin/server')).toBe('#admin/providers/call-audio')
  expect(movedHash('#admin/system')).toBe('#admin/providers/call-audio')
  expect(movedHash('#admin/settings')).toBe('#admin/features')
  expect(movedHash('#admin/settings/integrations')).toBe('#admin/features')
  expect(movedHash('#admin/settings/signup')).toBe('#admin/access')
  expect(movedHash('#admin/billing/signup')).toBe('#admin/access')
  expect(movedHash('#admin/call-reviews')).toBe('#admin/call-quality')
  expect(movedHash('#admin/billing/events')).toBe('#admin/audit?kind=stripe')
  expect(movedHash('#admin/billing/events?filter=failed')).toBe('#admin/audit?kind=stripe&filter=failed')
  // Everything that did not move stays.
  expect(movedHash('#admin/billing/bill_1')).toBeNull()
  expect(movedHash('#admin/providers/call-audio')).toBeNull()
  expect(movedHash('#admin/providers/stripe')).toBeNull()
  expect(movedHash('#admin/workspaces')).toBeNull()
  expect(movedHash('#settings/calls')).toBeNull()
  expect(billingTab('stripe')).toBe('stripe')
  expect(billingTab('signup')).toBeNull()
  expect(billingTab('events')).toBeNull()
})

test("Workspaces' views and the Audit log's Stripe events have their own address", () => {
  expect(workspaceViewOfHash('#admin/workspaces')).toBe('all')
  expect(workspaceViewOfHash('#admin/workspaces?view=at-risk')).toBe('at-risk')
  expect(workspaceViewOfHash('#admin/workspaces?view=nope')).toBe('all')
  expect(workspacesHref('all')).toBe('#admin/workspaces')
  expect(workspacesHref('usage')).toBe('#admin/workspaces?view=usage')
  expect(stripeEventsHref()).toBe('#admin/audit?kind=stripe')
  expect(stripeEventsHref('unhandled')).toBe('#admin/audit?kind=stripe&filter=unhandled')
})

test('Tab and Shift-Tab go round the sections', () => {
  expect(nextSection('overview', false)).toBe('workspaces')
  expect(nextSection('overview', true)).toBe('audit')
  expect(nextSection('providers', false)).toBe('access')
  expect(nextSection('users', false)).toBe('partners')
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
  // Overview, then three groups, each starting with its heading.
  expect(adminSections.map(s => s.id)).toEqual([
    'overview',
    'workspaces',
    'users',
    'partners',
    'billing',
    'prompt',
    'call-quality',
    'features',
    'providers',
    'access',
    'branding',
    'audit',
  ])
  const heads = adminSections.flatMap(s => ('group' in s ? [[s.id, enMessages[s.group]]] : []))
  expect(heads).toEqual([
    ['workspaces', 'Customers'],
    ['prompt', 'Assistant'],
    ['providers', 'Server'],
  ])
})

test('digits 1 to 9, then 0, open the first ten sections in order; Branding and the Audit log have none', () => {
  const keys = adminSections.slice(0, 10).map((_, i) => sectionKey(i))
  expect(keys).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'])
  for (const [i] of keys.entries()) expect(sectionIndexOfKey(sectionKey(i)!)).toBe(i)
  expect(adminSections[9]!.id).toBe('access')
  expect(adminSections[10]!.id).toBe('branding')
  expect(sectionKey(10)).toBeUndefined()
  expect(parseAdminHash('#admin/billing/bill_1')).toEqual({ section: 'billing', id: 'bill_1' })
})

test('Billing sections have their own address; anything else under Billing is a bill', () => {
  expect(billingTab(null)).toBe('overview')
  expect(billingTab('rules')).toBe('rules')
  expect(billingTab('bill_1')).toBeNull()
  expect(isListPlace({ section: 'billing', id: 'rules' })).toBe(true)
  expect(isListPlace({ section: 'billing', id: 'bill_1' })).toBe(false)
  // Esc and the crumb go one step up: a bill to the bills, a section to Billing, Billing nowhere.
  expect(placeUp({ section: 'billing', id: 'bill_1' })).toEqual({ section: 'billing', id: 'bills' })
  expect(placeUp({ section: 'billing', id: 'rules' })).toEqual({ section: 'billing', id: null })
  expect(placeUp({ section: 'billing', id: null })).toBeNull()
  expect(placeUp({ section: 'workspaces', id: 'ws1' })).toEqual({ section: 'workspaces', id: null })
})
