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

test('with ElevenLabs set up, Korean and Polish can be picked and are offered', async () => {
  noVoice()
  vi.stubEnv('ELEVENLABS_API_KEY', 'el-test')
  const ws = await createWorkspace('Brightwater Plumbing & Heating')
  const options = await act(ws.owner, 'voice.options', {})
  expect(options.body.data.languages).toEqual(expect.arrayContaining(['en', 'es', 'zh', 'ko', 'pl', 'hu']))
  const languages = { main: 'ko', mode: 'allowed', allowed: ['en', 'pl'] }
  expect((await act(ws.owner, 'assistant.update', { assistantId: ws.assistant.id, languages })).status).toBe(200)
  const [saved] = await db.select().from(assistants).where(eq(assistants.id, ws.assistant.id))
  expect(saved?.languages).toEqual(languages)
})

test('a language no voice provider set up speaks is not offered and cannot be saved', async () => {
  noVoice()
  vi.stubEnv('CARTESIA_API_KEY', 'ct-test')
  vi.stubEnv('TTS_MODEL', 'sonic-2') // Sonic 2 has Korean but no Vietnamese or Hungarian
  const ws = await createWorkspace('Brightwater Plumbing & Heating')
  const offered = (await act(ws.owner, 'voice.options', {})).body.data.languages
  expect(offered).toContain('ko')
  expect(offered).not.toContain('vi')
  const refused = await act(ws.owner, 'assistant.update', {
    assistantId: ws.assistant.id,
    languages: { main: 'en', mode: 'allowed', allowed: ['ko', 'vi', 'hu'] },
  })
  expect(refused.status).toBe(409)
  expect(JSON.stringify(refused.body)).toContain('Vietnamese and Hungarian')
  expect(
    (
      await act(ws.owner, 'assistant.update', {
        assistantId: ws.assistant.id,
        languages: { main: 'en', mode: 'allowed', allowed: ['ko'] },
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
  expect(flux.languages).toContain('ko')
  expect(flux.anyLanguages).toEqual(['en', 'es', 'fr', 'de', 'it', 'pt', 'nl', 'ru', 'hi', 'ja'])
  vi.stubEnv('STT_MODEL', 'nova-3')
  const nova = (await act(ws.owner, 'voice.options', {})).body.data
  expect(nova.anyLanguages).toEqual(nova.languages)
})
