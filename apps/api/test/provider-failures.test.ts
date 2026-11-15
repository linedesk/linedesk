// Runtime provider failures (provider-failures.ts): recorded per provider, cleared by a success, one email per
// streak (none for a test, none for email itself), and the voice agent's reports through the registry. The table is
// install-wide, so this file is in INSTANCE_WIDE_FILES (vitest.config.ts).
import { provider_failures } from '@linedesk/db'
import { inArray } from 'drizzle-orm'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { db } from '../src/db.ts'
import { problemOfStatus } from '../src/provider-errors.ts'
import {
  clearProviderFailures,
  diagnoseProvider,
  forgetDiagnoses,
  listProviderFailures,
  providerFailureEmail,
  recordProviderFailure,
  refineProblem,
  smtpProblem,
} from '../src/provider-failures.ts'
import { act, agent, createWorkspace } from './helpers.ts'

const alerts = vi.hoisted(() => ({ sent: [] as { subject: string; text: string }[] }))
vi.mock('../src/admin-alerts.ts', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/admin-alerts.ts')>()),
  alertInstanceAdmins: async (subject: string, text: string) => void alerts.sent.push({ subject, text }),
}))

// Providers no other instance-wide test records failures for.
const MINE = ['mistral', 'groq', 'gmail', 'elevenlabs_stt'] as const
const quota = { reason: 'quota' as const, message: 'Mistral quota or credit used up (HTTP 402).' }

beforeEach(async () => {
  alerts.sent.length = 0
  await db.delete(provider_failures).where(inArray(provider_failures.provider, [...MINE]))
})

const mine = async () => (await listProviderFailures(db)).filter(f => (MINE as readonly string[]).includes(f.provider))

describe('record and clear', () => {
  test('the first failure starts a streak and emails the admins once; more failures count up', async () => {
    const t0 = new Date('2026-11-13T08:00:00Z')
    expect(await recordProviderFailure(db, 'mistral', quota, 'llm', { now: t0 })).toEqual({ ...quota, alerted: true })
    const later = { reason: 'auth' as const, message: 'Mistral rejected the key (HTTP 401).' }
    expect(
      await recordProviderFailure(db, 'mistral', later, 'llm', { now: new Date('2026-11-13T08:05:00Z') }),
    ).toMatchObject({ alerted: false })
    expect(await mine()).toEqual([
      expect.objectContaining({
        provider: 'mistral',
        category: 'llm',
        label: 'Mistral',
        reason: 'auth',
        message: later.message,
        source: 'llm',
        since: '2026-11-13T08:00:00.000Z',
        last_at: '2026-11-13T08:05:00.000Z',
        count: 2,
      }),
    ])
    expect(alerts.sent).toHaveLength(1)
    expect(alerts.sent[0]!.subject).toMatch(/^Mistral is failing on .*: quota or credit used up$/)
  })

  test('a success clears it; the next failure is a new streak with a new email', async () => {
    await recordProviderFailure(db, 'mistral', quota, 'llm')
    await clearProviderFailures(db, ['mistral'])
    expect(await mine()).toEqual([])
    await recordProviderFailure(db, 'mistral', quota, 'llm')
    expect(alerts.sent).toHaveLength(2)
    expect((await mine())[0]!.count).toBe(1)
  })

  test("an admin's own test records without an email; the first failure of a call then emails", async () => {
    await recordProviderFailure(db, 'groq', quota, 'test')
    expect(alerts.sent).toHaveLength(0)
    await recordProviderFailure(db, 'groq', quota, 'agent')
    expect(alerts.sent).toHaveLength(1)
    await recordProviderFailure(db, 'groq', quota, 'agent')
    expect(alerts.sent).toHaveLength(1)
  })

  test('email failing: recorded, no email about it (it could not go out); shown in the app only', async () => {
    const problem = smtpProblem(Object.assign(new Error('Invalid login'), { code: 'EAUTH', responseCode: 535 }))
    expect(problem).toMatchObject({ reason: 'auth' })
    expect(await recordProviderFailure(db, 'gmail', problem!, 'email')).toMatchObject({ alerted: false })
    expect(alerts.sent).toHaveLength(0)
    expect((await mine()).map(f => f.provider)).toEqual(['gmail'])
  })

  test('a per-call race (two replies at once) is not the provider failing: not recorded, no email, old rows hidden', async () => {
    const race = {
      reason: 'unknown' as const,
      message:
        'Conversation already has an active response in progress: resp_1. {"code":"conversation_already_has_active_response"}',
    }
    expect(await recordProviderFailure(db, 'groq', race, 'agent')).toMatchObject({ alerted: false })
    expect(await mine()).toEqual([])
    expect(alerts.sent).toHaveLength(0)
    // A row recorded before this rule: read as no failure.
    const at = new Date().toISOString()
    await db.insert(provider_failures).values({ provider: 'groq', ...race, source: 'agent', since: at, last_at: at, count: 1 })
    expect(await mine()).toEqual([])
  })

  test('a long message is cut; the email has no links', async () => {
    const long = { reason: 'unknown' as const, message: `see https://evil.example/x ${'x'.repeat(400)}` }
    await recordProviderFailure(db, 'mistral', long, 'llm', { diagnose: async () => null })
    expect((await mine())[0]!.message.length).toBeLessThanOrEqual(300)
    expect(providerFailureEmail('mistral', long).text).not.toContain('https://')
  })
})

describe("a vague failure is refined by the provider's own test", () => {
  const noAudio = { reason: 'no_output' as const, message: 'TTS stream completed but no audio' }
  const quotaFound = { ok: false, status: 'error' as const, reason: 'quota' as const, message: 'ElevenLabs quota used up.' }

  test('no audio from the voice: the test finds the used-up quota; the email and the record say so', async () => {
    const diagnose = vi.fn(async () => quotaFound)
    const recorded = await recordProviderFailure(db, 'elevenlabs_stt', noAudio, 'agent', { diagnose })
    expect(recorded).toEqual({ reason: 'quota', message: 'ElevenLabs quota used up.', alerted: true })
    expect((await mine())[0]).toMatchObject({ reason: 'quota', message: 'ElevenLabs quota used up.' })
    expect(alerts.sent[0]!.subject).toMatch(/quota or credit used up$/)
  })

  test('a test that passes, cannot run or is vague itself keeps the failure as reported', async () => {
    for (const found of [{ ok: true, status: 'ok' as const, message: 'Connected' }, null, { ...quotaFound, reason: 'network' as const }]) {
      expect(await refineProblem('elevenlabs', noAudio, async () => found)).toEqual(noAudio)
    }
  })

  test('a clear reason is not tested again', async () => {
    const diagnose = vi.fn(async () => quotaFound)
    expect(await refineProblem('elevenlabs', quota, diagnose)).toEqual(quota)
    expect(diagnose).not.toHaveBeenCalled()
  })

  test('the diagnosis runs once per provider in its window, shared by every failure', async () => {
    forgetDiagnoses()
    // No keys for Mistral here: the diagnosis does not run a test and finds nothing; it is still not repeated.
    const first = diagnoseProvider('mistral')
    expect(diagnoseProvider('mistral')).toBe(first)
    expect(await first).toBeNull()
    forgetDiagnoses(['mistral'])
    expect(diagnoseProvider('mistral')).not.toBe(first)
  })
})

describe('what a failed email says about the service', () => {
  test.each([
    [{ code: 'ETIMEDOUT' }, 'network'],
    [{ responseCode: 554, response: '554 Sender address not verified' }, 'config'],
    [{ responseCode: 452, response: '452 Daily sending quota exceeded' }, 'quota'],
    [{ responseCode: 550, response: '550 No such user here' }, null],
  ])('%j → %s', (error, reason) => {
    expect(smtpProblem(Object.assign(new Error('x'), error))?.reason ?? null).toBe(reason)
  })
})

test('a failed answer becomes a reason and a text that names the fix, never the body', () => {
  const problem = problemOfStatus('elevenlabs', 401, '{"detail":{"status":"quota_exceeded","message":"key sk_123"}}')
  expect(problem.reason).toBe('quota')
  expect(problem.message).toMatch(/^ElevenLabs quota or credit used up \(HTTP 401\)\. Add credit/)
  expect(problem.message).not.toContain('sk_123')
})

describe('the voice agent reports through the registry', () => {
  test('a failure the agent reported (call.reportVoiceFailure) is cleared by provider.reportOk; members may not', async () => {
    const ws = await createWorkspace('Provider failures')
    // call.reportVoiceFailure records it like this (source agent, with the call's workspace).
    await recordProviderFailure(
      db,
      'elevenlabs_stt',
      { reason: 'no_output', message: 'ElevenLabs Scribe gave no transcript for 20 s of caller audio.' },
      'agent',
      { scope: { workspaceId: ws.id, callId: null } },
    )
    expect(await mine()).toEqual([
      expect.objectContaining({ provider: 'elevenlabs_stt', reason: 'no_output', source: 'agent', workspace_id: ws.id }),
    ])
    // provider.reportFailure is gone: the agent never called it (E10).
    expect(
      (
        await act(agent(ws.id), 'provider.reportFailure', {
          provider: 'elevenlabs_stt',
          reason: 'no_output',
          message: 'x',
        })
      ).status,
    ).toBe(404)
    expect((await act(ws.owner, 'provider.reportOk', { providers: ['elevenlabs_stt'] })).status).toBe(403)
    expect((await act(agent(ws.id), 'provider.reportOk', { providers: ['elevenlabs_stt'] })).status).toBe(200)
    expect(await mine()).toEqual([])
  })
})
