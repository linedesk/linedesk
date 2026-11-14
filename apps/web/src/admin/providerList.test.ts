import { type ProviderName, pinnedProvidersOf, providersIn } from '@linedesk/actions'
import { expect, test } from 'vitest'
import { orderProviders, visibleProviders } from './providerList.ts'

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
  const stt = providersIn('stt')
  expect(stt).toHaveLength(3)
  const list = visibleProviders(stt, { pinned: pinnedProvidersOf('stt'), keep: none, expanded: false })
  expect(list.shown[0]).toBe('deepgram')
  expect(list).toMatchObject({ hidden: 0, foldable: false })
  expect([...list.shown].sort()).toEqual([...stt].sort())
})
