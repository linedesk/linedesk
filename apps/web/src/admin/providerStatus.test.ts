import { groupSpec, type ProviderName, providerNames, providerSpec } from '@linedesk/actions'
import { expect, test } from 'vitest'
import type { ActiveProviders, AdminData, AdminHealth, ProviderStatus } from './api.ts'
import { callAudioOf, groupNote, keysSignature, providerFacts, providerStatus, testedAgo } from './providerStatus.ts'

/** Every provider as the API lists it; `set` ones have their key stored in the app. */
function data(set: ProviderName[], over: Partial<AdminData> = {}): AdminData {
  const providers: ProviderStatus[] = providerNames.map(provider => ({
    provider,
    label: providerSpec(provider).label,
    category: providerSpec(provider).category,
    fields: Object.keys(providerSpec(provider).fields).map(field => ({
      field,
      label: field,
      secret: true,
      hint: null,
      source: set.includes(provider) ? ('app' as const) : null,
      last4: set.includes(provider) ? 'abcd' : null,
      value: null,
      updated_at: set.includes(provider) ? '2026-11-14T09:00:00.000Z' : null,
      updated_by: null,
    })),
  }))
  const active = Object.fromEntries(
    ['telephony', 'stt', 'llm', 'tts', 'realtime', 'email', 'sign_in', 'recording', 'business'].map(c => [
      c,
      { provider: set.find(p => providerSpec(p).category === c) ?? null, chosen: false },
    ]),
  ) as ActiveProviders
  return {
    workspaces: [],
    users: [],
    usage: [],
    usageMonths: 0,
    providers,
    activeProviders: active,
    canStoreKeys: true,
    providerFailures: [],
    tests: {},
    statusContext: {},
    ...over,
  }
}
const providerIn = (d: AdminData, name: ProviderName) => d.providers.find(p => p.provider === name)!
const groupOf = (s: ReturnType<typeof providerStatus>, id: string) => s.groups.find(g => g.id === id)!
const passed = { ok: true, message: 'Connected', at: '2026-11-14T10:00:00.000Z' }
const health: AdminHealth = {
  api: { ok: true, message: 'Running' },
  readSync: { ok: true, message: 'Running' },
  livekit: { ok: true, message: 'LiveKit answers' },
  sip: { ok: true, message: '1 inbound trunk' },
  agent: { ok: true, message: 'Asked 2 min ago' },
  email: { ok: true, message: 'Resend' },
  livekitConfigured: true,
}

test('a provider shows not set up, not tested, checking, works or failing, the same words as the API', () => {
  const d = data(['deepgram'])
  expect(providerStatus(data([])).lines.deepgram.state).toBe('missing')
  expect(providerStatus(d).lines.deepgram.state).toBe('untested')
  const keys = keysSignature(providerIn(d, 'deepgram'))
  expect(providerStatus(d, { deepgram: { keys, test: 'running' } }).lines.deepgram.state).toBe('checking')
  expect(providerStatus({ ...d, tests: { deepgram: passed } }).lines.deepgram.state).toBe('works')
  const failed = { ok: false, message: 'Deepgram rejected the key.', at: passed.at }
  expect(providerStatus({ ...d, tests: { deepgram: failed } }).lines.deepgram).toMatchObject({
    state: 'failing',
    message: 'Deepgram rejected the key.',
  })
})

test('a test run on the page counts only for the keys it ran with', () => {
  const d = data(['deepgram'])
  const old = { keys: 'other keys', test: passed }
  expect(providerFacts(d, { deepgram: old }).find(f => f.provider === 'deepgram')?.test).toBeNull()
  const now = { keys: keysSignature(providerIn(d, 'deepgram')), test: passed }
  expect(providerFacts(d, { deepgram: now }).find(f => f.provider === 'deepgram')?.test).toEqual(passed)
})

test('a recorded failure beats the stored pass until a newer test passes', () => {
  const d = data(['elevenlabs'], {
    tests: { elevenlabs: passed },
    providerFailures: [
      {
        provider: 'elevenlabs',
        category: 'tts',
        label: 'ElevenLabs',
        reason: 'quota',
        message: 'ElevenLabs quota used up.',
        since: '2026-11-14T10:30:00.000Z',
        last_at: '2026-11-14T10:30:00.000Z',
        count: 1,
        source: 'voice',
        workspace_id: null,
        call_id: null,
      },
    ],
  })
  expect(providerStatus(d).lines.elevenlabs).toMatchObject({ state: 'failing', detail: 'Quota or credit used up' })
  const keys = keysSignature(providerIn(d, 'elevenlabs'))
  const later = { keys, test: { ...passed, at: '2026-11-14T11:00:00.000Z' } }
  expect(providerStatus(d, { elevenlabs: later }).lines.elevenlabs.state).toBe('works')
})

test('call audio comes from the health check: checking until it answers, not set up without LiveKit in .env', () => {
  expect(groupOf(providerStatus(data([])), 'call-audio').state).toBe('checking')
  expect(groupOf(providerStatus(data([]), {}, health), 'call-audio').state).toBe('works')
  const unset = { ...health, livekitConfigured: false, livekit: { ok: false, message: 'Not set' } }
  expect(groupOf(providerStatus(data([]), {}, unset), 'call-audio').state).toBe('missing')
  // An older API without livekitConfigured: LiveKit counts as set, so a failing one shows as failing.
  const { livekitConfigured: _, ...older } = health
  expect(callAudioOf(older)?.configured).toBe(true)
})

test('ready once every group a call needs works', () => {
  const tests = { resend: passed, telnyx: passed, openai_realtime: passed }
  const s = providerStatus(data(['resend', 'telnyx', 'openai_realtime'], { tests }), {}, health)
  expect(s.ready).toBe(true)
  expect(groupOf(s, 'answering').message).toBe('Answered by OpenAI Realtime.')
})

test('"tested 4 min ago"', () => {
  const now = Date.parse('2026-11-14T10:04:10.000Z')
  expect(testedAgo(null, now)).toBeNull()
  expect(testedAgo('2026-11-14T10:04:00.000Z', now)).toBe('tested just now')
  expect(testedAgo('2026-11-14T10:00:00.000Z', now)).toBe('tested 4 min ago')
  expect(testedAgo('2026-11-14T07:00:00.000Z', now)).toBe('tested 3 h ago')
  expect(testedAgo('2026-11-12T07:00:00.000Z', now)).toBe('tested Nov 12')
})

test('a group says why it is there once: not again inside the walkthrough step, whose lede already says it', () => {
  const tests = { resend: passed }
  const email = groupOf(providerStatus(data(['resend'], { tests }), {}, health), 'email')
  expect(groupNote(email)).toBe(groupSpec('email').why)
  expect(groupNote(email, true)).toBeNull()
  // A problem is shown in both places.
  const failing = groupOf(
    providerStatus(
      data(['resend'], { tests: { resend: { ...passed, ok: false, message: 'Resend rejected the key.' } } }),
      {},
      health,
    ),
    'email',
  )
  expect(groupNote(failing)).toBe('Resend rejected the key.')
  expect(groupNote(failing, true)).toBe('Resend rejected the key.')
})
