import {
  groupText,
  type ProviderFailure,
  type ProviderName,
  providerNames,
  providerSpec,
  statusText,
} from '@linedesk/actions'
import { expect, test } from 'vitest'
import type { ActiveProviders, AdminData, AdminHealth, ProviderStatus } from './api.ts'
import {
  callAudioOf,
  groupAttention,
  groupHelp,
  groupNote,
  groupProblem,
  groupValue,
  keysSignature,
  providerFacts,
  providerStatus,
  rowStatus,
  settleAwaited,
  storedSignature,
  testedAgo,
} from './providerStatus.ts'

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
  // Older than a day: the calendar day where the viewer is (Nov 11 in US time zones, Nov 12 in UTC and east of it).
  const older = '2026-11-12T07:00:00.000Z'
  expect(testedAgo(older, now)).toBe(`tested Nov ${new Date(older).getDate()}`)
})

test('why a group is there is help on demand, and not again inside the walkthrough step, whose lede says it', () => {
  const tests = { resend: passed }
  const email = groupOf(providerStatus(data(['resend'], { tests }), {}, health), 'email')
  // A group that is fine has no visible line; why it is there sits behind the (?).
  expect(groupNote(email)).toBeNull()
  expect(groupHelp(email)).toBe(groupText('email').why)
  expect(groupHelp(email, true)).toBeNull()
  // A failing provider says it on its own card (ProviderError), not again in a line above it.
  const failing = groupOf(
    providerStatus(
      data(['resend'], { tests: { resend: { ...passed, ok: false, message: 'Resend rejected the key.' } } }),
      {},
      health,
    ),
    'email',
  )
  expect(groupNote(failing)).toBeNull()
  expect(groupProblem(failing)).toEqual({ line: 'The API key is not accepted.', detail: 'Resend rejected the key.' })
})

test('a raw realtime error: "Failing" once, no line above the card, a short line on the overview', () => {
  const raw =
    'Conversation already has an active response in progress: resp_DfQ9xXkT2ab. Wait until the response is finished before creating a new one. {"type":"invalid_request_error","code":"conversation_already_has_active_response","message":"Conversation already has an active response in progress: re'
  const failure: ProviderFailure = {
    provider: 'resend',
    category: 'email',
    label: 'Resend',
    reason: 'unknown',
    message: raw,
    source: 'agent',
    since: '2026-11-15T01:00:00.000Z',
    last_at: '2026-11-15T01:00:00.000Z',
    count: 1,
    workspace_id: null,
    call_id: null,
  }
  const status = providerStatus(
    data(['resend'], { tests: { resend: passed }, providerFailures: [failure] }),
    {},
    health,
  )
  const email = groupOf(status, 'email')
  expect(status.lines.resend).toMatchObject({ state: 'failing', detail: null, failedAt: failure.last_at })
  expect(statusText(status.lines.resend)).toBe('Failing')
  expect(groupNote(email)).toBeNull()
  expect(groupProblem(email)).toEqual({ line: 'A call sent two replies at once. Calls still work.', detail: raw })
})

test('a group heading shows a status only for a problem: failing, partly, or not set up while calls need it', () => {
  expect(groupAttention({ state: 'works', needed: true })).toBeNull()
  expect(groupAttention({ state: 'checking', needed: true })).toBeNull()
  expect(groupAttention({ state: 'off', needed: false })).toBeNull()
  expect(groupAttention({ state: 'failing', needed: false })).toBe('failing')
  expect(groupAttention({ state: 'partly', needed: true })).toBe('partly')
  expect(groupAttention({ state: 'missing', needed: true })).toBe('missing')
  expect(groupAttention({ state: 'missing', needed: false })).toBeNull()
})

test('a working provider shows only its mark; its words, the choice and keys from the server go in the tooltip', () => {
  const works = { state: 'works' as const, detail: null }
  expect(rowStatus(works)).toEqual({ label: 'Works', words: null })
  expect(rowStatus(works, { use: 'in_use', fromServer: true })).toEqual({
    label: 'Works · In use · Keys set on the server',
    words: null,
  })
  // Not in use where there is a choice: worth saying.
  expect(rowStatus(works, { use: 'not_in_use' })).toEqual({ label: 'Works · Not in use', words: 'Not in use' })
  // States that need attention keep their words next to the mark.
  expect(rowStatus({ state: 'failing', detail: 'Key rejected' })).toEqual({
    label: 'Failing: Key rejected',
    words: 'Failing: Key rejected',
  })
  expect(rowStatus({ state: 'untested', detail: null }, { use: 'in_use' }).words).toBe('Not tested · In use')
  expect(rowStatus({ state: 'checking', detail: null }).words).toBe('Checking…')
})

test('the overview names what is in use, compact, and the problem in words otherwise', () => {
  const tests = { resend: passed, deepgram: passed, openrouter: passed, elevenlabs: passed, openai_realtime: passed }
  const d = data(['resend', 'deepgram', 'openrouter', 'elevenlabs', 'openai_realtime'], {
    tests,
    statusContext: { assistantPipelines: ['realtime', 'three_stage'] },
  })
  const s = providerStatus(d, {}, health)
  expect(groupValue(groupOf(s, 'email'))).toBe('Resend')
  expect(groupValue(groupOf(s, 'answering'))).toBe('OpenAI Realtime · Deepgram · OpenRouter · ElevenLabs')
  const failing = providerStatus(
    data(['resend'], { tests: { resend: { ...passed, ok: false, message: 'Resend rejected the key.' } } }),
    {},
    health,
  )
  expect(groupValue(groupOf(failing, 'email'))).toBe('Failing')
  expect(groupValue(groupOf(failing, 'telephony'))).toBe('Not set up')
})

test('the development carrier says so on its line, as no provider row carries a mark for it', () => {
  const devCarrier = 'Development carrier (TELEPHONY_PROVIDER=dev): numbers and calls are simulated'
  const phone = groupOf(providerStatus(data([], { statusContext: { devCarrier } }), {}, health), 'telephony')
  expect(phone.state).toBe('works')
  expect(groupNote(phone)).toBe(devCarrier)
})

test('a problem reads the same on every screen: a short sentence, the server text and the fix behind the (?)', () => {
  const noTrunk = { ...health, sip: { ok: false, message: 'No inbound trunk, so no call can arrive (run setup-sip)' } }
  const audio = groupOf(providerStatus(data([]), {}, noTrunk), 'call-audio')
  expect(audio.state).toBe('partly')
  expect(groupNote(audio)).toBe("Calls can't come in yet: no SIP trunk.")
  expect(groupProblem(audio)?.detail).toContain('pnpm --filter @linedesk/agent setup-sip <number>')
  const down = groupOf(
    providerStatus(data([]), {}, { ...health, livekit: { ok: false, message: 'Connection refused' } }),
    'call-audio',
  )
  expect(groupProblem(down)).toEqual({
    line: "LiveKit can't be reached, so calls have no audio.",
    detail: 'Connection refused.',
  })
  // Works or not set up: no problem line.
  expect(groupProblem(groupOf(providerStatus(data([]), {}, health), 'call-audio'))).toBeNull()
  expect(groupProblem(groupOf(providerStatus(data([]), {}, health), 'email'))).toBeNull()
})

test('a test recorded right after Save waits for the reload with the new keys, then counts for them (LIN-364)', () => {
  const before = data([]).providers
  const after = data(['hubspot']).providers
  const hubspot = before.find(p => p.provider === 'hubspot')!
  const test = { ok: true, message: 'Connected', at: '2026-11-16T20:00:00.000Z' }
  const awaiting = new Map([['hubspot' as const, { before: storedSignature(hubspot), test }]])
  // The render before the reload: still the old keys, the test keeps waiting.
  expect(settleAwaited(awaiting, before)).toEqual([])
  expect(awaiting.size).toBe(1)
  // The reload brought the stored keys: the test counts for them, so the provider shows Works and is not checked again.
  const settled = settleAwaited(awaiting, after)
  expect(settled.map(([p, t]) => [p.provider, t])).toEqual([['hubspot', test]])
  expect(awaiting.size).toBe(0)
  const [p] = settled[0]!
  const facts = providerFacts({ ...data(['hubspot']), tests: {} }, { hubspot: { keys: keysSignature(p), test } })
  expect(facts.find(f => f.provider === 'hubspot')?.test).toEqual(test)
})

test('the same keys saved again still settle: when they were saved is part of the signature', () => {
  const first = data(['hubspot']).providers.find(p => p.provider === 'hubspot')!
  const again = { ...first, fields: first.fields.map(f => ({ ...f, updated_at: '2026-11-16T20:00:00.000Z' })) }
  expect(keysSignature(again)).toBe(keysSignature(first))
  expect(storedSignature(again)).not.toBe(storedSignature(first))
})
