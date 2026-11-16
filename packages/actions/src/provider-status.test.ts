import { describe, expect, test } from 'vitest'
import {
  groupOfCategory,
  groupOfProvider,
  isNeededProvider,
  type ProviderFact,
  providerConnectOneKey,
  providerGroups,
  providerLine,
  providerNames,
  providerSpec,
  providersIn,
  providersOfGroup,
  readiness,
  recommendedProviders,
  pinnedProviders,
  pinnedProvidersOf,
  providerCategories,
  type ProviderCategory,
  redactInput,
  type StatusInput,
  statusGroups,
  statusText,
} from './index.ts'

const at = (minute: number) => `2026-11-14T10:${String(minute).padStart(2, '0')}:00.000Z`
const works = (provider: ProviderFact['provider'], minute = 0): ProviderFact => ({
  provider,
  configured: true,
  active: true,
  test: { ok: true, message: 'Connected', at: at(minute) },
})
/** Every provider not set up, plus the given facts. */
const input = (facts: ProviderFact[], extra: Partial<StatusInput> = {}): StatusInput => ({
  providers: providerNames.map(
    p => facts.find(f => f.provider === p) ?? { provider: p, configured: false, active: false, test: null },
  ),
  callAudio: {
    configured: true,
    server: { ok: true, message: 'LiveKit answers' },
    sip: { ok: true, message: '1 inbound trunk' },
  },
  ...extra,
})
const group = (i: StatusInput, id: string) => statusGroups(i).groups.find(g => g.id === id)!

describe('groups', () => {
  test('the same order and ids everywhere; needed for calls: email, carrier, answering, call audio', () => {
    expect(providerGroups.map(g => g.id)).toEqual([
      'email',
      'telephony',
      'answering',
      'call-audio',
      'sign-in',
      'calendar',
      'apps',
      'recording',
      'transcript',
      'business',
      'billing',
    ])
    expect(providerGroups.filter(g => g.needed).map(g => g.id)).toEqual([
      'email',
      'telephony',
      'answering',
      'call-audio',
    ])
  })

  test('every provider is in exactly one group to manage it, and old category links find their group', () => {
    for (const p of providerNames) expect(providersOfGroup(groupOfProvider(p)), p).toContain(p)
    expect(groupOfCategory('stt')).toBe('answering')
    expect(groupOfCategory('sign_in')).toBe('sign-in')
    expect(providersOfGroup('calendar')).toEqual(['google', 'microsoft', 'calendly', 'calcom'])
    expect(providersOfGroup('sign-in')).toEqual(['google', 'microsoft', 'github', 'oidc'])
    expect(isNeededProvider('deepgram')).toBe(true)
    expect(isNeededProvider('google_places')).toBe(false)
  })

  test('every provider has a guide with steps and a cost; each recommended provider is of its category', () => {
    for (const p of providerNames) {
      const { guide } = providerSpec(p)
      expect(guide.steps.length, p).toBeGreaterThan(1)
      expect(guide.cost, p).toBeTruthy()
      if (guide.url) expect(guide.url, p).toMatch(/^https:\/\//)
    }
    for (const [category, p] of Object.entries(recommendedProviders))
      expect(providersIn(category as never)).toContain(p)
  })

  test('the short lists: Email Resend and SMTP, the language model OpenAI, OpenRouter and Anthropic, each led by the recommended one', () => {
    expect(pinnedProvidersOf('email')).toEqual(['resend', 'smtp'])
    expect(pinnedProvidersOf('llm')).toEqual(['openai', 'openrouter', 'anthropic'])
    expect(pinnedProvidersOf('sign_in')).toEqual(['google', 'oidc'])
    for (const category of Object.keys(providerCategories) as ProviderCategory[]) {
      const pinned = pinnedProvidersOf(category)
      expect(pinned[0], category).toBe(recommendedProviders[category])
      for (const p of pinned) expect(providersIn(category), category).toContain(p)
      expect(new Set(pinned).size, category).toBe(pinned.length)
    }
    for (const [category, list] of Object.entries(pinnedProviders)) expect(list!.length, category).toBeLessThan(4)
  })
})

describe('providerLine', () => {
  test('not set up, checking, not tested, works, failing by its test', () => {
    expect(providerLine({ provider: 'deepgram', configured: false, active: false, test: null }).state).toBe('missing')
    expect(providerLine({ ...works('deepgram'), test: 'running' }).state).toBe('checking')
    expect(providerLine({ ...works('deepgram'), test: null }).state).toBe('untested')
    expect(providerLine(works('deepgram')).state).toBe('works')
    const failed = providerLine({ ...works('deepgram'), test: { ok: false, message: 'Rejected', at: at(1) } })
    expect(failed).toMatchObject({ state: 'failing', message: 'Rejected' })
  })

  test('a recorded failure beats a stored passing test until a newer test passes', () => {
    const failure = { provider: 'elevenlabs' as const, reason: 'quota' as const, message: 'Used up', last_at: at(5) }
    const stale = providerLine(works('elevenlabs', 1), [failure])
    expect(stale).toMatchObject({ state: 'failing', detail: 'Quota or credit used up', message: 'Used up' })
    expect(statusText(stale)).toBe('Failing: Quota or credit used up')
    expect(providerLine(works('elevenlabs', 9), [failure]).state).toBe('works')
  })

  test('new keys saved after a failure: the failure was about the old keys', () => {
    const failure = { provider: 'deepgram' as const, reason: 'auth' as const, message: 'Rejected', last_at: at(5) }
    const fresh = { provider: 'deepgram' as const, configured: true, active: true, test: null, keysAt: at(7) }
    expect(providerLine(fresh, [failure]).state).toBe('untested')
    expect(providerLine({ ...fresh, keysAt: at(2) }, [failure]).state).toBe('failing')
  })

  test('the OpenAI key check says what it proves', () => {
    expect(providerLine(works('openai_realtime')).message).toBe('Key accepted')
  })
})

describe('statusGroups', () => {
  test('a fresh install: needed groups not set up, optional ones off, not ready', () => {
    const { groups, ready } = statusGroups(input([], { callAudio: undefined }))
    expect(groups.map(g => [g.id, g.state])).toEqual([
      ['email', 'missing'],
      ['telephony', 'missing'],
      ['answering', 'missing'],
      ['call-audio', 'checking'],
      ['sign-in', 'off'],
      ['calendar', 'off'],
      ['apps', 'off'],
      ['recording', 'off'],
      ['transcript', 'off'],
      ['business', 'off'],
      ['billing', 'off'],
    ])
    expect(ready).toBe(false)
    expect(readiness(groups)).toMatchObject({ state: 'missing', headline: 'Not ready for calls yet' })
  })

  test('the realtime model answers: one status; the stages it replaces are not needed', () => {
    const answering = group(input([works('openai_realtime')]), 'answering')
    expect(answering).toMatchObject({
      state: 'works',
      provider: 'openai_realtime',
      message: 'Answered by OpenAI Realtime.',
    })
    expect(answering.parts.map(p => p.state)).toEqual(['works', 'not_needed', 'not_needed', 'not_needed'])
    expect(answering.answeredBy).toEqual(['OpenAI Realtime'])
    expect(answering.answeredWith).toEqual(['realtime'])
  })

  test('answeredBy names each provider that answers, once: never "a, b and c and d"', () => {
    const facts = [works('openai_realtime'), works('deepgram'), works('openrouter'), works('elevenlabs')]
    const three = group(input(facts, { assistantPipelines: ['three_stage'] }), 'answering')
    expect(three.answeredBy).toEqual(['Deepgram', 'OpenRouter', 'ElevenLabs'])
    const both = group(input(facts, { assistantPipelines: ['realtime', 'three_stage'] }), 'answering')
    expect(both.answeredBy).toEqual(['OpenAI Realtime', 'Deepgram', 'OpenRouter', 'ElevenLabs'])
    expect(three.answeredWith).toEqual(['three_stage'])
    expect(both.answeredWith).toEqual(['realtime', 'three_stage'])
    // Only the group that answers calls has it.
    expect(group(input([works('resend')]), 'email').answeredBy).toBeUndefined()
    expect(group(input([works('resend')]), 'email').answeredWith).toBeUndefined()
  })

  test('an assistant that chose the three stages, which are not set up, falls back to the realtime model', () => {
    const answering = group(input([works('openai_realtime')], { assistantPipelines: ['three_stage'] }), 'answering')
    expect(answering.message).toBe('Answered by OpenAI Realtime.')
  })

  test('both set up and both chosen: both answer; a failing stage makes the group fail with its reason', () => {
    const facts = [works('openai_realtime'), works('deepgram'), works('openrouter'), works('elevenlabs')]
    const both = group(input(facts, { assistantPipelines: ['realtime', 'three_stage'] }), 'answering')
    expect(both.message).toBe(
      'Answered by OpenAI Realtime and Deepgram, OpenRouter and ElevenLabs, as each assistant chose.',
    )
    const failing = group(
      input(facts, {
        assistantPipelines: ['three_stage'],
        failures: [{ provider: 'elevenlabs', reason: 'auth', message: 'Rejected', last_at: at(3) }],
      }),
      'answering',
    )
    expect(statusText(failing)).toBe('Failing: Key rejected')
  })

  test('the three stages half set up: partly works, naming what is missing', () => {
    const answering = group(input([works('deepgram')]), 'answering')
    expect(statusText(answering)).toBe('Partly works: language model and voice missing')
  })

  test('call audio: not in .env, down, without SIP, or working', () => {
    const audio = (callAudio: StatusInput['callAudio']) => group(input([], { callAudio }), 'call-audio').state
    const ok = { ok: true, message: 'ok' }
    const bad = { ok: false, message: 'no' }
    expect(audio({ configured: false, server: bad, sip: bad })).toBe('missing')
    expect(audio({ configured: true, server: bad, sip: bad })).toBe('failing')
    expect(audio({ configured: true, server: ok, sip: bad })).toBe('partly')
    expect(audio({ configured: true, server: ok, sip: ok })).toBe('works')
  })

  test('ready once every needed group works; an optional group failing shows but does not block calls', () => {
    const facts = [works('resend'), works('telnyx'), works('openai_realtime'), works('google_places')]
    const ready = statusGroups(input(facts))
    expect(ready.ready).toBe(true)
    expect(readiness(ready.groups)).toMatchObject({ state: 'ready', headline: 'Ready for calls' })
    const lookupFails = statusGroups(
      input(facts, { failures: [{ provider: 'google_places', reason: 'quota', message: 'x', last_at: at(9) }] }),
    )
    expect(lookupFails.ready).toBe(true)
    expect(readiness(lookupFails.groups)).toMatchObject({ state: 'failing', headline: 'Business lookup is failing' })
    const carrierFails = statusGroups(
      input(facts, { failures: [{ provider: 'telnyx', reason: 'auth', message: 'x', last_at: at(9) }] }),
    )
    expect(readiness(carrierFails.groups)).toMatchObject({
      state: 'blocked',
      headline: 'Calls are not answered',
      reason: 'Phone carrier: Failing: Key rejected',
    })
  })

  test('development: the dev carrier works, email to the log says so', () => {
    const groups = statusGroups(input([], { devCarrier: 'Development carrier', emailToLog: true })).groups
    expect(groups.find(g => g.id === 'telephony')).toMatchObject({ state: 'works', message: 'Development carrier' })
    expect(groups.find(g => g.id === 'email')?.message).toContain('EMAIL_TO_LOG')
  })
})

test('one key: one server action, instance admins only, the key redacted in the command log', () => {
  expect(providerConnectOneKey).toMatchObject({ name: 'provider.connectOneKey', permission: 'instance:admin' })
  expect(providerConnectOneKey.sensitive).toEqual(['apiKey'])
  expect(redactInput(providerConnectOneKey, { apiKey: 'sk-made-up-0123456789' })).not.toEqual({
    apiKey: 'sk-made-up-0123456789',
  })
  expect(providerConnectOneKey.input.safeParse({ apiKey: ' ' }).success).toBe(false)
})
