import { expect, test } from 'vitest'
import {
  checklistSummary,
  providerConnectOneKey,
  providerSpec,
  redactInput,
  setupItems,
  setupItemState,
} from './index.ts'

test('an item is missing without keys, set up until tested, then ok or failing by its last test', () => {
  expect(setupItemState(false, null)).toBe('missing')
  expect(setupItemState(false, { ok: true })).toBe('missing')
  expect(setupItemState(true, null)).toBe('set_up')
  expect(setupItemState(true, { ok: true })).toBe('ok')
  expect(setupItemState(true, { ok: false })).toBe('failing')
})

test('complete only when every item works', () => {
  expect(checklistSummary([{ state: 'ok' }, { state: 'ok' }])).toEqual({ ready: 2, complete: true })
  expect(checklistSummary([{ state: 'ok' }, { state: 'set_up' }])).toEqual({ ready: 1, complete: false })
  expect(checklistSummary([{ state: 'failing' }, { state: 'missing' }])).toEqual({ ready: 0, complete: false })
})

test('the checklist covers a first answered call, and each guide is for a provider of its category', () => {
  expect(setupItems.map(item => item.id)).toEqual(['email', 'telephony', 'stt', 'llm', 'tts', 'livekit'])
  for (const item of setupItems) {
    expect(item.guide.steps.length, item.id).toBeGreaterThan(1)
    expect(item.guide.url, item.id).toMatch(/^https:\/\//)
    expect(item.guide.cost, item.id).toBeTruthy()
    if (item.guide.provider) expect(providerSpec(item.guide.provider).category, item.id).toBe(item.category)
    else expect(item.category).toBeNull()
  }
})

test('one key: one server action, instance admins only, the key redacted in the command log', () => {
  expect(providerConnectOneKey).toMatchObject({ name: 'provider.connectOneKey', permission: 'instance:admin' })
  expect(providerConnectOneKey.sensitive).toEqual(['apiKey'])
  expect(redactInput(providerConnectOneKey, { apiKey: 'sk-made-up-0123456789' })).not.toEqual({
    apiKey: 'sk-made-up-0123456789',
  })
  expect(providerConnectOneKey.input.safeParse({ apiKey: ' ' }).success).toBe(false)
})
