// Install setup by hand (LIN-128, install-setup.ts): where the walkthrough is (install.setProgress, GET
// /v1/admin/install-setup), and the round trips that show a part works (provider.tryOut, provider.confirmEmail):
// instance admins only, real requests to the provider in use (stubbed here), the result in the setup checklist, and
// no key or audio in the command log. Sets provider keys and instance settings, so it is one of the instance-wide
// files (vitest.config.ts).
import { commands, instance_settings, provider_settings, user } from '@linedesk/db'
import { eq } from 'drizzle-orm'
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { db } from '../src/db.ts'
import { emailSender } from '../src/email.ts'
import { forgetEmailCodes, wordMatch } from '../src/install-setup.ts'
import { forgetTests } from '../src/setup-checklist.ts'
import { PREVIEW_TEXT } from '../src/voices.ts'
import { act, addMember, createWorkspace, request, type User, type Workspace } from './helpers.ts'

const SECRET = 'KEY-made-up-install-0123456789'

let home: Workspace
let other: Workspace
let operator: User
let member: User

type TryOut = {
  ok: boolean
  kind: string
  message: string
  provider: string | null
  seconds?: number
  reply?: string
  heard?: string
  audio?: string
  numbers?: string[]
  sentTo?: string
}
const tryOut = async (kind: string, extra: Record<string, unknown> = {}) => {
  const res = await act(operator, 'provider.tryOut', { kind, ...extra })
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  return res.body.data as TryOut
}
const checklistGroup = async (id: string) => {
  const res = await request(operator, 'GET', '/v1/admin/setup-checklist')
  return (res.body.groups as { id: string; state: string }[]).find(g => g.id === id)!
}
/** A provider's line in the setup checklist (its group: Answering calls). */
const checklistLine = async (provider: string) => {
  const res = await request(operator, 'GET', '/v1/admin/setup-checklist')
  const groups = res.body.groups as { parts: { provider: string; state: string; message: string | null }[] }[]
  return groups.flatMap(g => g.parts).find(p => p.provider === provider)!
}
const logged = async () => JSON.stringify(await db.select().from(commands))

beforeAll(async () => {
  home = await createWorkspace('Linedesk Operations')
  other = await createWorkspace('Brightwater Plumbing & Heating')
  operator = home.owner
  await db.update(user).set({ instanceAdmin: true }).where(eq(user.id, operator.userId))
  member = await addMember(other.id, 'member')
}, 60_000)

beforeEach(async () => {
  await db.delete(provider_settings)
  await db.delete(instance_settings)
  await forgetTests(db)
  forgetEmailCodes()
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  delete process.env.LINEDESK_INSTALL_SETUP
})

describe('access', () => {
  test.each([
    ['provider.tryOut', { kind: 'telephony' }],
    ['provider.confirmEmail', { code: '123456' }],
    ['install.setProgress', { step: 'email' }],
  ])('%s: instance admins only', async (name, input) => {
    for (const who of [other.owner, member]) {
      const res = await act(who, name, input)
      expect(res.status, name).toBe(403)
    }
  })

  test('GET /v1/admin/install-setup: instance admins only', async () => {
    expect((await request(operator, 'GET', '/v1/admin/install-setup')).status).toBe(200)
    expect((await request(other.owner, 'GET', '/v1/admin/install-setup')).status).toBe(403)
  })
})

describe('progress', () => {
  test('starts at welcome; step, skip, set aside and finish are remembered', async () => {
    const start = (await request(operator, 'GET', '/v1/admin/install-setup')).body
    expect(start).toMatchObject({
      enabled: true,
      progress: { step: 'welcome', skipped: [], finishedAt: null, setAsideAt: null, manualBy: [] },
      restart: { pending: false },
    })

    await act(operator, 'install.setProgress', { step: 'answering', skip: 'email' })
    await act(operator, 'install.setProgress', { skip: 'email' })
    await act(operator, 'install.setProgress', { setAside: true })
    let progress = (await request(operator, 'GET', '/v1/admin/install-setup')).body.progress
    expect(progress).toMatchObject({ step: 'answering', skipped: ['email'] })
    expect(progress.setAsideAt).toEqual(expect.any(String))

    await act(operator, 'install.setProgress', { setAside: false, finished: true, step: 'done' })
    progress = (await request(operator, 'GET', '/v1/admin/install-setup')).body.progress
    expect(progress).toMatchObject({ step: 'done', setAsideAt: null, finishedAt: expect.any(String) })
  })

  test('set up by hand: remembered for this admin on this install, not for another admin or a new install', async () => {
    const second = await addMember(other.id, 'member')
    await db.update(user).set({ instanceAdmin: true }).where(eq(user.id, second.userId))
    const byHand = async (who: User) => (await request(who, 'GET', '/v1/me')).body.setupByHand
    // A new install: every admin starts on the agent setup page.
    expect(await byHand(operator)).toBe(false)
    expect(await byHand(second)).toBe(false)

    expect((await act(operator, 'install.setProgress', { manual: true })).status).toBe(200)
    await act(operator, 'install.setProgress', { manual: true })
    expect((await request(operator, 'GET', '/v1/admin/install-setup')).body.progress.manualBy).toEqual([
      operator.userId,
    ])
    expect(await byHand(operator)).toBe(true)
    expect(await byHand(second)).toBe(false)
    // Not instance admins: never asked.
    expect(await byHand(member)).toBe(false)

    // Back to the agent page ("Set up with an AI agent instead").
    await act(operator, 'install.setProgress', { manual: false })
    expect(await byHand(operator)).toBe(false)

    // A fresh database is a new install: the choice is gone with it.
    await act(operator, 'install.setProgress', { manual: true })
    await db.delete(instance_settings)
    expect(await byHand(operator)).toBe(false)
  })

  test('changes sent at the same time all stay (leaving sends where it was left and the manual choice at once)', async () => {
    const sent = await Promise.all([
      act(operator, 'install.setProgress', { setAside: true }),
      act(operator, 'install.setProgress', { manual: true }),
      act(operator, 'install.setProgress', { skip: 'email' }),
      act(operator, 'install.setProgress', { skip: 'call-audio' }),
      act(operator, 'install.setProgress', { finished: true, step: 'done' }),
    ])
    expect(sent.map(r => r.status)).toEqual([200, 200, 200, 200, 200])
    const progress = (await request(operator, 'GET', '/v1/admin/install-setup')).body.progress
    expect(progress).toMatchObject({
      step: 'done',
      setAsideAt: expect.any(String),
      finishedAt: expect.any(String),
      manualBy: [operator.userId],
    })
    expect([...progress.skipped].sort()).toEqual(['call-audio', 'email'])
  })

  test('an empty change is refused', async () => {
    expect((await act(operator, 'install.setProgress', {})).status).toBe(422)
  })

  test('a walkthrough left at a step from before the groups resumes at the step that holds it now', async () => {
    const value = JSON.stringify({ step: 'tts', skipped: ['stt', 'llm', 'extras'], finishedAt: null, setAsideAt: null })
    await db.insert(instance_settings).values({ key: 'setup.install', value })
    const progress = (await request(operator, 'GET', '/v1/admin/install-setup')).body.progress
    expect(progress).toMatchObject({ step: 'answering', skipped: ['answering', 'call-audio'] })
    // The old step names are not accepted any more.
    expect((await act(operator, 'install.setProgress', { step: 'llm' })).status).toBe(422)
  })

  test('off on Cloud: LINEDESK_INSTALL_SETUP=off', async () => {
    process.env.LINEDESK_INSTALL_SETUP = 'off'
    expect((await request(operator, 'GET', '/v1/admin/install-setup')).body.enabled).toBe(false)
  })
})

describe('provider.tryOut', () => {
  test('telephony: lists available numbers for an area code, buys nothing', async () => {
    const result = await tryOut('telephony', { areaCode: '971' })
    expect(result).toMatchObject({ ok: true, kind: 'telephony' })
    expect(result.numbers).toHaveLength(3)
    expect(result.numbers!.every(n => n.startsWith('+1971'))).toBe(true)
    expect(result.message).toContain('Nothing was purchased')
  })

  test('telephony: a wrong area code is refused before anything runs', async () => {
    expect((await act(operator, 'provider.tryOut', { kind: 'telephony', areaCode: '123' })).status).toBe(422)
  })

  test('llm: nothing set up says so, without a request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await tryOut('llm')).toMatchObject({ ok: false, provider: null })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('llm: asks the live model one question and reports the answer and the time; the checklist shows it works', async () => {
    await act(operator, 'provider.setKeys', { provider: 'openrouter', values: { api_key: SECRET } })
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) =>
      Response.json({ choices: [{ message: { content: 'I am sorry to hear that. Let me get your address.' } }] }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const result = await tryOut('llm')
    expect(result).toMatchObject({ ok: true, provider: 'OpenRouter', reply: expect.stringContaining('address') })
    expect(result.seconds).toEqual(expect.any(Number))
    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toContain('openrouter.ai')
    expect(String(url)).toContain('/chat/completions')
    expect((init!.headers as Record<string, string>).authorization).toBe(`Bearer ${SECRET}`)
    expect(JSON.stringify(result)).not.toContain(SECRET)
    expect((await checklistLine('openrouter')).state).toBe('works')
    expect(await logged()).not.toContain(SECRET)
  })

  test('llm: a rejected key fails with what to do, and the checklist shows it failing', async () => {
    await act(operator, 'provider.setKeys', { provider: 'openrouter', values: { api_key: SECRET } })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"error":{"message":"No auth"}}', { status: 401 })),
    )
    const result = await tryOut('llm')
    expect(result.ok).toBe(false)
    expect(result.message).not.toContain(SECRET)
    expect((await checklistLine('openrouter')).state).toBe('failing')
  })

  test('stt: transcribes the bundled recording and compares it with what it says', async () => {
    await act(operator, 'provider.setKeys', { provider: 'deepgram', values: { api_key: SECRET } })
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) =>
      Response.json({ results: { channels: [{ alternatives: [{ transcript: PREVIEW_TEXT }] }] } }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const result = await tryOut('stt')
    expect(result).toMatchObject({ ok: true, provider: 'Deepgram', heard: PREVIEW_TEXT })
    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toContain('api.deepgram.com/v1/listen')
    expect((init!.body as Uint8Array).byteLength).toBeGreaterThan(1000)
    expect((await checklistLine('deepgram')).state).toBe('works')
  })

  test('stt: words that do not match fail', async () => {
    await act(operator, 'provider.setKeys', { provider: 'deepgram', values: { api_key: SECRET } })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ results: { channels: [{ alternatives: [{ transcript: 'banana' }] }] } })),
    )
    expect((await tryOut('stt')).ok).toBe(false)
  })

  test('tts: speaks a sentence the page can play; the audio stays out of the command log', async () => {
    await act(operator, 'provider.setKeys', { provider: 'elevenlabs', values: { api_key: SECRET } })
    const fetchMock = vi.fn(async (_url: unknown) => new Response(new Uint8Array(2048).fill(7)))
    vi.stubGlobal('fetch', fetchMock)
    const result = await tryOut('tts')
    expect(result).toMatchObject({ ok: true, provider: 'ElevenLabs' })
    expect(result.audio).toMatch(/^data:audio\/mpeg;base64,/)
    expect(String(fetchMock.mock.calls[0]![0])).toContain('api.elevenlabs.io/v1/text-to-speech/')
    const log = await logged()
    expect(log).not.toContain(result.audio!.slice(30, 80))
    expect(log).not.toContain(SECRET)
  })
})

describe('email round trip', () => {
  test('a code goes to the admin; the right code confirms, a wrong one does not, a used one is gone', async () => {
    const sent: { to: string; text: string }[] = []
    vi.spyOn(emailSender, 'send').mockImplementation(async message => {
      sent.push(message)
    })
    const result = await tryOut('email')
    expect(result.ok).toBe(true)
    expect(sent).toHaveLength(1)
    expect(result.sentTo).toBe(sent[0]!.to)
    const code = sent[0]!.text.match(/\b(\d{6})\b/)![1]!
    expect(JSON.stringify(result)).not.toContain(code)

    const wrong = code === '000000' ? '111111' : '000000'
    expect((await act(operator, 'provider.confirmEmail', { code: wrong })).status).toBe(409)
    const right = await act(operator, 'provider.confirmEmail', { code })
    expect(right).toMatchObject({ status: 200, body: { data: { ok: true } } })
    expect((await act(operator, 'provider.confirmEmail', { code })).status).toBe(409)
    // Sent to the API log (EMAIL_TO_LOG), not by a mail server: the checklist does not call email working.
    expect((await checklistGroup('email')).state).not.toBe('works')
    // The code is never kept in the command log.
    expect(await logged()).not.toContain(`"${code}"`)
  })

  test('a mail server error is a fixed text, its own words only in the API log', async () => {
    vi.spyOn(emailSender, 'send').mockRejectedValue(new Error('535 5.7.8 auth failed for user desk@example.com'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = await tryOut('email')
    expect(result.ok).toBe(false)
    expect(result.message).not.toContain('535')
  })

  test('five wrong codes use it up', async () => {
    const sent: { text: string }[] = []
    vi.spyOn(emailSender, 'send').mockImplementation(async message => {
      sent.push(message)
    })
    await tryOut('email')
    const code = sent[0]!.text.match(/\b(\d{6})\b/)![1]!
    const wrong = code === '000000' ? '111111' : '000000'
    for (let i = 0; i < 5; i++) await act(operator, 'provider.confirmEmail', { code: wrong })
    expect((await act(operator, 'provider.confirmEmail', { code })).status).toBe(409)
  })
})

test('wordMatch: share of the expected words that came back', () => {
  expect(wordMatch('Hi, thanks for calling.', 'hi thanks for calling')).toBe(1)
  expect(wordMatch('one two three four', 'one two')).toBe(0.5)
  expect(wordMatch('', 'x')).toBe(0)
})
