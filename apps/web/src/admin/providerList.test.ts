import { type ProviderName, pinnedProvidersOf, providersIn } from '@linedesk/actions'
import { expect, test } from 'vitest'
import type { AdminData } from './api.ts'
import {
  allOpen,
  answeringWayMark,
  defaultAnsweringWay,
  foldableLists,
  listsOfGroup,
  orderProviders,
  pinnedOfList,
  visibleProviders,
  wayAfterKey,
} from './providerList.ts'

const email = providersIn('email')
const llm = providersIn('llm')
const none = () => false

test('the pinned providers come first in their order (recommended first), then the rest in their usual order', () => {
  expect(email).toEqual(['smtp', 'resend', 'postmark', 'sendgrid', 'brevo', 'mailgun', 'gmail'])
  expect(orderProviders(email, pinnedProvidersOf('email'))).toEqual([
    'resend',
    'smtp',
    'postmark',
    'sendgrid',
    'brevo',
    'mailgun',
    'gmail',
  ])
  expect(orderProviders(llm, pinnedProvidersOf('llm')).slice(0, 3)).toEqual(['openai', 'openrouter', 'anthropic'])
  expect(orderProviders(providersIn('sign_in'), pinnedProvidersOf('sign_in'))).toEqual([
    'google',
    'oidc',
    'microsoft',
    'calendly',
    'calcom',
    'github',
  ])
})

test('a long list shows only the pinned providers until "Show more"', () => {
  expect(visibleProviders(email, { pinned: pinnedProvidersOf('email'), keep: none, expanded: false })).toEqual({
    shown: ['resend', 'smtp'],
    hidden: 5,
    foldable: true,
  })
  const shortLlm = visibleProviders(llm, { pinned: pinnedProvidersOf('llm'), keep: none, expanded: false })
  expect(shortLlm).toEqual({ shown: ['openai', 'openrouter', 'anthropic'], hidden: llm.length - 3, foldable: true })
  const open = visibleProviders(email, { pinned: pinnedProvidersOf('email'), keep: none, expanded: true })
  expect(open).toEqual({ shown: orderProviders(email, pinnedProvidersOf('email')), hidden: 0, foldable: true })
})

test('providers that are set up, being tested or failing are always shown', () => {
  const keep = (p: ProviderName) => p === 'mailgun' || p === 'brevo'
  expect(visibleProviders(email, { pinned: pinnedProvidersOf('email'), keep, expanded: false })).toEqual({
    shown: ['resend', 'smtp', 'brevo', 'mailgun'],
    hidden: 3,
    foldable: true,
  })
  const groq = visibleProviders(llm, { pinned: pinnedProvidersOf('llm'), keep: p => p === 'groq', expanded: false })
  expect(groq.shown).toEqual(['openai', 'openrouter', 'anthropic', 'groq'])
})

test('three or fewer: every provider, recommended first, nothing to fold', () => {
  const tts = providersIn('tts')
  expect(tts.length).toBeLessThanOrEqual(3)
  const list = visibleProviders(tts, { pinned: pinnedProvidersOf('tts'), keep: none, expanded: false })
  expect(list.shown[0]).toBe('elevenlabs')
  expect(list).toMatchObject({ hidden: 0, foldable: false })
  expect([...list.shown].sort()).toEqual([...tts].sort())
})

test('a group has one list per category, Answering four; call audio none', () => {
  expect(listsOfGroup('email').map(l => l.key)).toEqual(['email/email'])
  expect(listsOfGroup('answering').map(l => l.category)).toEqual(['realtime', 'stt', 'llm', 'tts'])
  expect(listsOfGroup('call-audio')).toEqual([])
})

test('"Show all providers" opens the lists that fold something away, and reads "Show fewer" once all are open', () => {
  const lists = [...listsOfGroup('email'), ...listsOfGroup('answering')]
  const foldable = foldableLists(lists, none, new Set())
  expect(foldable).toEqual(['email/email', 'answering/stt', 'answering/llm'])
  expect(allOpen(foldable, new Set())).toBe(false)
  expect(allOpen(foldable, new Set(['email/email']))).toBe(false)
  expect(allOpen(foldable, new Set(foldable))).toBe(true)
  // An open list stays in the set, so the button can fold it again.
  expect(foldableLists(lists, () => true, new Set(['email/email']))).toEqual(['email/email'])
  expect(allOpen([], new Set())).toBe(false)
})

/** Admin data with these providers chosen for their categories. */
const active = (chosen: Partial<Record<'realtime' | 'stt' | 'llm' | 'tts', ProviderName>>) =>
  ({
    activeProviders: Object.fromEntries(Object.entries(chosen).map(([c, provider]) => [c, { provider }])),
  }) as unknown as AdminData
const three = { stt: 'deepgram', llm: 'openrouter', tts: 'elevenlabs' } as const

test('the Answering tab that opens is the way that answers calls now, else the one partly set up, else the realtime model', () => {
  const both = active({ realtime: 'openai_realtime', ...three })
  expect(defaultAnsweringWay({ answeredWith: ['three_stage'] }, both)).toBe('three_stage')
  expect(defaultAnsweringWay({ answeredWith: ['realtime'] }, both)).toBe('realtime')
  // Both answer (assistants chose differently): the realtime model, the default way.
  expect(defaultAnsweringWay({ answeredWith: ['three_stage', 'realtime'] }, both)).toBe('realtime')
  // Nothing answers yet.
  expect(defaultAnsweringWay({}, active({ stt: 'deepgram' }))).toBe('three_stage')
  expect(defaultAnsweringWay({}, active({}))).toBe('realtime')
  expect(defaultAnsweringWay({}, active({ realtime: 'openai_realtime', stt: 'deepgram' }))).toBe('realtime')
})

test('a tab says "In use" for the way that answers, and shows a check for one that works but is not used', () => {
  const data = active({ realtime: 'openai_realtime', ...three })
  const works = { state: 'works' } as never
  const lines = { openai_realtime: works, deepgram: works, openrouter: works, elevenlabs: works }
  const group = { answeredWith: ['realtime' as const] }
  expect(answeringWayMark('realtime', group, data, lines)).toBe('in_use')
  expect(answeringWayMark('three_stage', group, data, lines)).toBe('works')
  // A part failing or missing: no check.
  expect(
    answeringWayMark('three_stage', group, data, { ...lines, openrouter: { state: 'failing' } as never }),
  ).toBeNull()
  expect(answeringWayMark('three_stage', group, active({ realtime: 'openai_realtime' }), lines)).toBeNull()
})

test('arrow keys, Home and End move between the two Answering tabs; other keys do nothing', () => {
  expect(wayAfterKey('realtime', 'ArrowRight')).toBe('three_stage')
  expect(wayAfterKey('three_stage', 'ArrowRight')).toBe('realtime')
  expect(wayAfterKey('realtime', 'ArrowLeft')).toBe('three_stage')
  expect(wayAfterKey('three_stage', 'Home')).toBe('realtime')
  expect(wayAfterKey('realtime', 'End')).toBe('three_stage')
  expect(wayAfterKey('realtime', 'Enter')).toBeNull()
})

test("the calendar apps' list never folds: the one-click switches above it point to its Calendly and Cal.com apps", () => {
  const calendar = ['google', 'microsoft', 'calendly', 'calcom'] as const
  expect(pinnedOfList('sign_in', calendar)).toEqual(calendar)
  expect(
    visibleProviders(calendar, { pinned: pinnedOfList('sign_in', calendar), keep: () => false, expanded: false }),
  ).toMatchObject({ hidden: 0 })
  expect(pinnedOfList('sign_in', providersIn('sign_in'))).toEqual(pinnedProvidersOf('sign_in'))
})
