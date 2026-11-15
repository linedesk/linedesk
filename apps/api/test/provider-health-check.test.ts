// The background health check (provider-health-check.ts): the free key check of every provider that is set up,
// stored like any test, one email per failure until the provider works again, nothing for optional providers or for
// one passing blip, and never a paid round trip. Sets provider keys and stored tests, so it is one of the
// instance-wide files (vitest.config.ts).
import type { ProviderName, ProviderTestData } from '@linedesk/actions'
import { instance_settings, provider_failures, provider_settings, provider_tests } from '@linedesk/db'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { db } from '../src/db.ts'
import { forgetDiagnoses } from '../src/provider-failures.ts'
import {
  DEFAULT_HEALTH_CHECK_HOURS,
  healthCheckCron,
  healthCheckHours,
  type KeyCheck,
  runProviderHealthCheck,
} from '../src/provider-health-check.ts'
import { setProviderKeys } from '../src/provider-settings.ts'
import { setupChecklist } from '../src/setup-checklist.ts'

const alerts = vi.hoisted(() => ({ sent: [] as { subject: string; text: string }[] }))
vi.mock('../src/admin-alerts.ts', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/admin-alerts.ts')>()),
  // The alert as an English-speaking admin reads it.
  alertInstanceAdmins: async (alert: (locale: string) => { subject: string; blocks: unknown[] }) => {
    const { subject, blocks } = alert('en')
    alerts.sent.push({ subject, text: JSON.stringify(blocks) })
  },
}))

const KEY = 'KEY-made-up-health-0123456789'
const keys = async (provider: ProviderName, values: Record<string, string>) =>
  setProviderKeys(db, provider, values, 'health-test', new Date().toISOString())

const ok: ProviderTestData = { ok: true, status: 'ok', message: 'Connected' }
const rejected: ProviderTestData = { ok: false, status: 'error', reason: 'auth', message: 'Deepgram rejected the key.' }
const unreachable: ProviderTestData = { ok: false, status: 'error', reason: 'network', message: 'Not reachable.' }
/** A key check that answers per provider; records what it was asked. */
const checkWith = (answers: Partial<Record<ProviderName, ProviderTestData>>) => {
  const asked: ProviderName[] = []
  const check: KeyCheck = async provider => {
    asked.push(provider)
    return answers[provider] ?? ok
  }
  return { check, asked }
}
const hoursLater = (h: number) => new Date(Date.now() + h * 3_600_000)
const quiet = { LIVEKIT_URL: '', TELEPHONY_PROVIDER: '' }

beforeEach(async () => {
  alerts.sent.length = 0
  forgetDiagnoses()
  await db.delete(provider_settings)
  await db.delete(instance_settings)
  await db.delete(provider_tests)
  await db.delete(provider_failures)
})
afterEach(() => vi.unstubAllGlobals())

describe('schedule', () => {
  test('every 6 hours by default; 1 to 24 hours; 0 or off turns it off; nonsense keeps the default', () => {
    expect(healthCheckHours({})).toBe(DEFAULT_HEALTH_CHECK_HOURS)
    expect(DEFAULT_HEALTH_CHECK_HOURS).toBe(6)
    expect(healthCheckHours({ PROVIDER_HEALTH_CHECK_HOURS: '12' })).toBe(12)
    expect(healthCheckHours({ PROVIDER_HEALTH_CHECK_HOURS: '0' })).toBeNull()
    expect(healthCheckHours({ PROVIDER_HEALTH_CHECK_HOURS: 'off' })).toBeNull()
    expect(healthCheckHours({ PROVIDER_HEALTH_CHECK_HOURS: '1.5' })).toBe(6)
    expect(healthCheckHours({ PROVIDER_HEALTH_CHECK_HOURS: '48' })).toBe(6)
    expect(healthCheckCron(6)).toBe('23 */6 * * *')
  })
})

describe('check', () => {
  test('tests every provider that is set up, stores the result and clears a failure on a pass', async () => {
    await keys('deepgram', { api_key: KEY })
    await keys('google_places', { api_key: KEY })
    const { check, asked } = checkWith({})
    const result = await runProviderHealthCheck(db, { check, env: quiet })
    expect(asked.sort()).toEqual(['deepgram', 'google_places'])
    expect(result).toEqual({ tested: expect.any(Array), failing: [], alerted: [] })
    expect((await db.select().from(provider_tests)).map(r => [r.provider, r.ok]).sort()).toEqual([
      ['deepgram', true],
      ['google_places', true],
    ])
    expect(JSON.stringify(await db.select().from(provider_tests))).not.toContain(KEY)
  })

  test('a needed provider in use starts failing: one email, not again while it fails, again after it recovered', async () => {
    await keys('deepgram', { api_key: KEY })
    const failing = checkWith({ deepgram: rejected })
    expect(await runProviderHealthCheck(db, { check: failing.check, env: quiet })).toMatchObject({
      failing: ['deepgram'],
      alerted: ['deepgram'],
    })
    expect(alerts.sent).toHaveLength(1)
    expect(alerts.sent[0]!.subject).toMatch(/^Deepgram is failing on .*: key rejected$/)
    // The next runs while it still fails: no more email.
    await runProviderHealthCheck(db, { check: failing.check, env: quiet, now: hoursLater(6) })
    await runProviderHealthCheck(db, { check: failing.check, env: quiet, now: hoursLater(12) })
    expect(alerts.sent).toHaveLength(1)
    // The overview shows it failing.
    const answering = (await setupChecklist(db, { env: quiet, livekit: livekitDown })).groups.find(
      g => g.id === 'answering',
    )!
    expect(answering.parts.find(p => p.provider === 'deepgram')).toMatchObject({
      state: 'failing',
      detail: 'Key rejected',
    })
    // Works again: the failure is cleared, no email about it.
    await runProviderHealthCheck(db, { check: checkWith({}).check, env: quiet, now: hoursLater(18) })
    expect(await db.select().from(provider_failures)).toEqual([])
    expect(alerts.sent).toHaveLength(1)
    // A new failure later is a new streak: one new email.
    await runProviderHealthCheck(db, { check: failing.check, env: quiet, now: hoursLater(24) })
    expect(alerts.sent).toHaveLength(2)
  })

  test('optional providers and providers not in use fail quietly: shown, never emailed', async () => {
    await keys('google_places', { api_key: KEY })
    // Two carriers set up: Telnyx is in use (first set up), Twilio only sits there.
    await keys('telnyx', { api_key: KEY })
    await keys('twilio', { account_sid: 'AC-made-up', auth_token: KEY })
    const { check } = checkWith({ google_places: rejected, twilio: rejected })
    const result = await runProviderHealthCheck(db, { check, env: quiet })
    expect(result.failing.sort()).toEqual(['google_places', 'twilio'])
    expect(result.alerted).toEqual([])
    expect(alerts.sent).toEqual([])
    expect((await db.select().from(provider_failures)).map(r => r.provider).sort()).toEqual(['google_places', 'twilio'])
  })

  test('one passing blip (not reachable) emails nobody; the same failure on the next run does', async () => {
    await keys('deepgram', { api_key: KEY })
    const { check } = checkWith({ deepgram: unreachable })
    expect((await runProviderHealthCheck(db, { check, env: quiet })).alerted).toEqual([])
    expect(alerts.sent).toHaveLength(0)
    expect((await runProviderHealthCheck(db, { check, env: quiet, now: hoursLater(6) })).alerted).toEqual(['deepgram'])
    expect(alerts.sent).toHaveLength(1)
  })

  test('no paid round trip: only the free key checks, no request that speaks, transcribes, chats or lists numbers', async () => {
    await keys('telnyx', { api_key: KEY })
    await keys('deepgram', { api_key: KEY })
    await keys('openrouter', { api_key: KEY })
    await keys('elevenlabs', { api_key: KEY })
    // The ones whose manual test spends a few tokens, a fifth of a second of audio or one character of speech.
    for (const provider of ['openai', 'anthropic', 'openai_stt', 'cartesia', 'openai_realtime'] as const)
      await keys(provider, { api_key: KEY })
    const requests: { url: string; method: string }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown, init?: RequestInit) => {
        requests.push({ url: String(url), method: init?.method ?? 'GET' })
        // Every free check reads as fine: a balance, a project, a key, a subscription with quota left.
        return new Response(
          JSON.stringify({
            data: { balance: '50', currency: 'USD', limit_remaining: 10, total_credits: 50, total_usage: 1 },
            projects: [{ project_id: 'p1' }],
            balances: [{ amount: 10 }],
            character_count: 1,
            character_limit: 100_000,
          }),
          { status: 200 },
        )
      }),
    )
    const result = await runProviderHealthCheck(db, { env: quiet })
    expect(result.tested.sort()).toEqual([
      'anthropic',
      'cartesia',
      'deepgram',
      'elevenlabs',
      'openai',
      'openai_realtime',
      'openai_stt',
      'openrouter',
      'telnyx',
    ])
    expect(requests.length).toBeGreaterThan(0)
    // Free checks read; a paid round trip (provider.tryOut) posts audio, text or a chat, or searches numbers.
    expect(requests.filter(r => r.method !== 'GET')).toEqual([])
    for (const { url } of requests)
      expect(url).not.toMatch(
        /available_phone_numbers|\/listen|speech-to-text|text-to-speech|chat\/completions|transcriptions|tts\//,
      )
  })
})

const livekitDown = async () => ({
  url: null,
  server: { ok: false, message: 'Not set' },
  sip: { ok: false, message: 'Not set' },
})
