// An assistant may speak only languages a voice provider of the install speaks (LIN-268): voice.options lists them and
// assistant.update refuses the others. The voice providers come from the environment here, never stored keys.
import { assistants } from '@linedesk/db'
import { eq } from 'drizzle-orm'
import { afterEach, expect, test, vi } from 'vitest'
import { db } from '../src/db.ts'
import { act, createWorkspace } from './helpers.ts'

afterEach(() => vi.unstubAllEnvs())

const noVoice = () => {
  for (const name of [
    'ELEVENLABS_API_KEY',
    'CARTESIA_API_KEY',
    'TTS_PROVIDER',
    'TTS_MODEL',
    'DEEPGRAM_API_KEY',
    'STT_PROVIDER',
    'STT_MODEL',
  ])
    vi.stubEnv(name, '')
}

test('with ElevenLabs set up, Polish and Swedish can be picked and are offered', async () => {
  noVoice()
  vi.stubEnv('ELEVENLABS_API_KEY', 'el-test')
  const ws = await createWorkspace('Brightwater Plumbing & Heating')
  const options = await act(ws.owner, 'voice.options', {})
  expect(options.body.data.languages).toEqual(expect.arrayContaining(['en', 'es', 'pl', 'sv', 'hu']))
  const languages = { main: 'pl', mode: 'allowed', allowed: ['en', 'sv'] }
  expect((await act(ws.owner, 'assistant.update', { assistantId: ws.assistant.id, languages })).status).toBe(200)
  const [saved] = await db.select().from(assistants).where(eq(assistants.id, ws.assistant.id))
  expect(saved?.languages).toEqual(languages)
})

test('a language no voice provider set up speaks is not offered and cannot be saved', async () => {
  noVoice()
  vi.stubEnv('CARTESIA_API_KEY', 'ct-test')
  vi.stubEnv('TTS_MODEL', 'sonic-2') // Sonic 2 has Polish but no Vietnamese or Hungarian
  const ws = await createWorkspace('Brightwater Plumbing & Heating')
  const offered = (await act(ws.owner, 'voice.options', {})).body.data.languages
  expect(offered).toContain('pl')
  expect(offered).not.toContain('vi')
  const refused = await act(ws.owner, 'assistant.update', {
    assistantId: ws.assistant.id,
    languages: { main: 'en', mode: 'allowed', allowed: ['pl', 'vi', 'hu'] },
  })
  expect(refused.status).toBe(409)
  expect(JSON.stringify(refused.body)).toContain('Vietnamese and Hungarian')
  expect(
    (
      await act(ws.owner, 'assistant.update', {
        assistantId: ws.assistant.id,
        languages: { main: 'en', mode: 'allowed', allowed: ['pl'] },
      })
    ).status,
  ).toBe(200)
  // Every language stays allowed: a call then speaks those the voice does.
  expect(
    (
      await act(ws.owner, 'assistant.update', {
        assistantId: ws.assistant.id,
        languages: { main: 'en', mode: 'any', allowed: [] },
      })
    ).status,
  ).toBe(200)
})

test('without a voice provider (a realtime model only) the languages are Flux’s ten, as before', async () => {
  noVoice()
  const ws = await createWorkspace('Brightwater Plumbing & Heating')
  expect((await act(ws.owner, 'voice.options', {})).body.data.languages).toEqual([
    'en',
    'es',
    'fr',
    'de',
    'it',
    'pt',
    'nl',
    'ru',
    'hi',
    'ja',
  ])
  expect(
    (
      await act(ws.owner, 'assistant.update', {
        assistantId: ws.assistant.id,
        languages: { main: 'de', mode: 'english', allowed: [] },
      })
    ).status,
  ).toBe(200)
  expect(
    (
      await act(ws.owner, 'assistant.update', {
        assistantId: ws.assistant.id,
        languages: { main: 'pl', mode: 'english', allowed: [] },
      })
    ).status,
  ).toBe(409)
})

test('languages the assistant already has stay saveable after the voice provider changed; new ones are checked', async () => {
  noVoice()
  vi.stubEnv('ELEVENLABS_API_KEY', 'el-test')
  const ws = await createWorkspace('Brightwater Plumbing & Heating')
  const update = (allowed: string[]) =>
    act(ws.owner, 'assistant.update', {
      assistantId: ws.assistant.id,
      languages: { main: 'en', mode: 'allowed', allowed },
    })
  expect((await update(['vi'])).status).toBe(200)
  vi.stubEnv('ELEVENLABS_API_KEY', '')
  vi.stubEnv('CARTESIA_API_KEY', 'ct-test')
  vi.stubEnv('TTS_MODEL', 'sonic-2')
  expect((await update(['vi'])).status).toBe(200)
  expect((await update(['vi', 'hu'])).status).toBe(409)
})

test('"any language" covers Flux\'s 10 when the speech recognition is a Flux model, every offered one on Nova', async () => {
  noVoice()
  vi.stubEnv('ELEVENLABS_API_KEY', 'el-test')
  vi.stubEnv('DEEPGRAM_API_KEY', 'dg-test')
  const ws = await createWorkspace('Brightwater Plumbing & Heating')
  const flux = (await act(ws.owner, 'voice.options', {})).body.data
  expect(flux.languages).toContain('pl')
  expect(flux.anyLanguages).toEqual(['en', 'es', 'fr', 'de', 'it', 'pt', 'nl', 'ru', 'hi', 'ja'])
  vi.stubEnv('STT_MODEL', 'nova-3')
  const nova = (await act(ws.owner, 'voice.options', {})).body.data
  expect(nova.anyLanguages).toEqual(nova.languages)
})

test('a hidden language (its test calls failed) is not offered and is refused as a new choice; one already saved stays', async () => {
  noVoice()
  vi.stubEnv('ELEVENLABS_API_KEY', 'el-test')
  vi.stubEnv('DEEPGRAM_API_KEY', 'dg-test')
  vi.stubEnv('STT_MODEL', 'nova-3')
  const ws = await createWorkspace('Brightwater Plumbing & Heating')
  const options = (await act(ws.owner, 'voice.options', {})).body.data
  for (const list of [options.languages, options.anyLanguages]) {
    expect(list).not.toContain('zh')
    expect(list).not.toContain('ko')
    expect(list).toContain('pl')
  }
  const update = (languages: { main: string; mode: string; allowed: readonly string[] }, voice?: object) =>
    act(ws.owner, 'assistant.update', { assistantId: ws.assistant.id, languages, ...(voice ? { voice } : {}) })
  const refused = await update({ main: 'en', mode: 'allowed', allowed: ['zh', 'pl'] })
  expect(refused.status).toBe(409)
  expect(JSON.stringify(refused.body)).toContain("Chinese can't be picked for now")
  expect((await update({ main: 'ko', mode: 'english', allowed: [] })).status).toBe(409)
  // Saved before the language was hidden: it stays, saved again as it is, with another language or another voice.
  const korean = { main: 'ko' as const, mode: 'allowed' as const, allowed: ['zh' as const] }
  await db.update(assistants).set({ languages: korean }).where(eq(assistants.id, ws.assistant.id))
  expect((await update(korean)).status).toBe(200)
  expect((await update({ ...korean, allowed: ['zh', 'pl'] })).status).toBe(200)
  // Another voice (a library voice of the ElevenLabs catalog): the hidden languages it has stay.
  const other = { provider: 'elevenlabs', voice_id: 'cgSgspJ2msm6clMCkdW9', model: 'eleven_flash_v2_5' }
  expect((await update(korean, other)).status).toBe(200)
  const [saved] = await db.select().from(assistants).where(eq(assistants.id, ws.assistant.id))
  expect(saved?.languages).toEqual(korean)
})
