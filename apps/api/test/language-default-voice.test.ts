// A German workspace speaks with a German voice when the assistant picked none (Janik, 2026-11-19): onboarding saves
// German's default voice (languageDefaultVoices), the API takes it like a curated voice, and a later change of the
// language moves it along while it is untouched. A voice picked by name stays. The voice providers come from the
// environment here, never stored keys.
import { assistants } from '@linedesk/db'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { db } from '../src/db.ts'
import { act, agent, createWorkspace, randomNumber } from './helpers.ts'

const SUSI = { provider: 'elevenlabs', voice_id: 'v3V1d2rk6528UrLKRuy8' } // German's default voice
const LUCIE = 'YxrwjAKoUKULGd0g8K9Y' // French's
const JESSICA = { provider: 'elevenlabs', voice_id: 'cgSgspJ2msm6clMCkdW9' } // curated, picked by name

beforeEach(() => {
  for (const name of ['CARTESIA_API_KEY', 'TTS_PROVIDER', 'DEEPGRAM_API_KEY', 'STT_PROVIDER', 'ELEVENLABS_STT_API_KEY'])
    vi.stubEnv(name, '')
  vi.stubEnv('ELEVENLABS_API_KEY', 'el-test')
})
afterEach(() => vi.unstubAllEnvs())

const voiceOf = async (id: string) => (await db.select().from(assistants).where(eq(assistants.id, id)))[0]!.voice

describe("a language's default voice", () => {
  test('onboarding saves it for a German workspace, and calls get it', async () => {
    const ws = await createWorkspace('Sanitär Dossenheim Default Voice')
    expect((await act(ws.owner, 'workspace.updateSettings', { country: 'DE' })).status).toBe(200)
    // Not one of the curated voices nor in a catalog read here: taken as a language default.
    const saved = await act(ws.owner, 'assistant.update', { assistantId: ws.assistant.id, voice: SUSI })
    expect(saved.status).toBe(200)
    expect(await voiceOf(ws.assistant.id)).toEqual(SUSI)
    const call = await act(agent(), 'call.start', { from: randomNumber(), to: ws.number })
    expect(call.body.data.assistant.voice).toEqual(SUSI)
    expect(call.body.data.workspaceLanguage).toBe('de')
  })

  test('a voice id that is neither curated, a language default nor a clone is still refused', async () => {
    const ws = await createWorkspace('Sanitär Made Up Voice')
    const voice = { provider: 'elevenlabs', voice_id: 'not-a-real-voice' }
    expect((await act(ws.owner, 'assistant.update', { assistantId: ws.assistant.id, voice })).status).not.toBe(200)
  })
})

describe('a new main language', () => {
  test('moves an untouched default voice to the new language default; a voice picked by name stays', async () => {
    const ws = await createWorkspace('Language Follow Plumbing')
    const german = { main: 'de', mode: 'english', allowed: [] }
    await act(ws.owner, 'assistant.update', { assistantId: ws.assistant.id, languages: german, voice: SUSI })
    expect(await voiceOf(ws.assistant.id)).toEqual(SUSI)

    const french = { main: 'fr', mode: 'english', allowed: [] }
    expect((await act(ws.owner, 'assistant.update', { assistantId: ws.assistant.id, languages: french })).status).toBe(
      200,
    )
    expect(await voiceOf(ws.assistant.id)).toEqual({ ...SUSI, voice_id: LUCIE })

    // Picked by name: kept through a change of the language.
    await act(ws.owner, 'assistant.update', { assistantId: ws.assistant.id, voice: JESSICA })
    await act(ws.owner, 'assistant.update', { assistantId: ws.assistant.id, languages: german })
    expect(await voiceOf(ws.assistant.id)).toEqual(JESSICA)

    // A voice sent with the languages is the one saved.
    await act(ws.owner, 'assistant.update', { assistantId: ws.assistant.id, languages: french, voice: SUSI })
    expect(await voiceOf(ws.assistant.id)).toEqual(SUSI)
  })

  test("the workspace's country moves an untouched default of the assistants that speak its language", async () => {
    const ws = await createWorkspace('Country Follow Sanitär')
    await act(ws.owner, 'workspace.updateSettings', { country: 'DE' })
    await act(ws.owner, 'assistant.update', { assistantId: ws.assistant.id, voice: SUSI })
    const copy = await act(ws.owner, 'assistant.create', { copyOf: ws.assistant.id })
    const second = (copy.body as { data: { assistantId: string } }).data.assistantId
    // The copy speaks German as its own main language: the workspace's country does not move it.
    await act(ws.owner, 'assistant.update', {
      assistantId: second,
      languages: { main: 'de', mode: 'english', allowed: [] },
    })
    expect(await voiceOf(second)).toEqual(SUSI)

    const moved = await act(ws.owner, 'workspace.updateSettings', { country: 'US' })
    expect(moved.status).toBe(200)
    // English has no language default: the provider's default voice again ('', Jessica on calls).
    expect(await voiceOf(ws.assistant.id)).toEqual({ ...SUSI, voice_id: '' })
    expect(await voiceOf(second)).toEqual(SUSI)

    // Picked by name: the country leaves it.
    await act(ws.owner, 'assistant.update', { assistantId: ws.assistant.id, voice: JESSICA })
    await act(ws.owner, 'workspace.updateSettings', { country: 'DE' })
    expect(await voiceOf(ws.assistant.id)).toEqual(JESSICA)
  })
})
