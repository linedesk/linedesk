import { expect, test } from 'vitest'
import { adminHash, nextSection, parseAdminHash, providersTarget, tabSwitchesSection } from './route.ts'

test('admin hashes name a section and optionally a row', () => {
  expect(parseAdminHash('#admin')).toEqual({ section: 'overview', id: null })
  expect(parseAdminHash('#admin/users')).toEqual({ section: 'users', id: null })
  expect(parseAdminHash('#admin/users/u%2F1')).toEqual({ section: 'users', id: 'u/1' })
  expect(parseAdminHash('#admin/nothing/1')).toEqual({ section: 'overview', id: null })
  expect(adminHash({ section: 'users', id: 'u/1' })).toBe('#admin/users/u%2F1')
  expect(adminHash({ section: 'system', id: null })).toBe('#admin/system')
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

test('Tab and Shift-Tab go round the sections', () => {
  expect(nextSection('overview', false)).toBe('workspaces')
  expect(nextSection('overview', true)).toBe('audit')
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
