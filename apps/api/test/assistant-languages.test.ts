// An assistant may speak only languages a voice provider of the install speaks (LIN-268): voice.options lists them and
// assistant.update refuses the others. The voice providers come from the environment here, never stored keys.
import { assistants } from '@linedesk/db'
import { eq } from 'drizzle-orm'
import { afterEach, expect, test, vi } from 'vitest'
import { db } from '../src/db.ts'
import { act, asServerAdmin, createWorkspace, signUp } from './helpers.ts'

afterEach(() => vi.unstubAllEnvs())

const noVoice = () => {
  for (const name of [
    'ELEVENLABS_API_KEY',
    'CARTESIA_API_KEY',
    'TTS_PROVIDER',
    'DEEPGRAM_API_KEY',
    'STT_PROVIDER',
    'ELEVENLABS_STT_API_KEY',
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

/**
 * The assistant on Premium with Eleven Multilingual v2, which has Polish but no Vietnamese or Hungarian. A language
 * model is set up too: the three stages then decide the voice model the calls use.
 */
async function onMultilingualV2(ws: Awaited<ReturnType<typeof createWorkspace>>) {
  vi.stubEnv('OPENAI_API_KEY', 'sk-test-made-up')
  const [row] = await db.select().from(assistants).where(eq(assistants.id, ws.assistant.id))
  const voice = { ...row!.voice, model: 'eleven_multilingual_v2' }
  const set = await act(ws.owner, 'assistant.update', { assistantId: ws.assistant.id, call_quality: 'premium', voice })
  expect(set.status).toBe(200)
}

test("a language the assistant's voice model does not speak cannot be saved", async () => {
  noVoice()
  vi.stubEnv('ELEVENLABS_API_KEY', 'el-test')
  const ws = await createWorkspace('Brightwater Plumbing & Heating')
  // The install's languages follow the Standard voice model (Flash v2.5): Vietnamese is offered.
  expect((await act(ws.owner, 'voice.options', {})).body.data.languages).toContain('vi')
  await onMultilingualV2(ws)
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

test("languages the assistant already has stay saveable after its level's voice model changed; new ones are checked", async () => {
  noVoice()
  vi.stubEnv('ELEVENLABS_API_KEY', 'el-test')
  vi.stubEnv('OPENAI_API_KEY', 'sk-test-made-up')
  const ws = await createWorkspace('Brightwater Plumbing & Heating')
  const update = (allowed: string[]) =>
    act(ws.owner, 'assistant.update', {
      assistantId: ws.assistant.id,
      languages: { main: 'en', mode: 'allowed', allowed },
    })
  const premiumVoice = (model: string) =>
    asServerAdmin(operator, () =>
      act(operator, 'callQuality.set', { models: { premium: { voice: { elevenlabs: model } } } }),
    )
  const operator = await signUp()
  expect((await premiumVoice('eleven_v3')).status).toBe(200)
  try {
    expect(
      (await act(ws.owner, 'assistant.update', { assistantId: ws.assistant.id, call_quality: 'premium' })).status,
    ).toBe(200)
    expect((await update(['vi'])).status).toBe(200)
    // The server admin makes Multilingual v2 Premium's voice model: Vietnamese stays, Hungarian is refused.
    expect((await premiumVoice('eleven_multilingual_v2')).status).toBe(200)
    expect((await update(['vi'])).status).toBe(200)
    expect((await update(['vi', 'hu'])).status).toBe(409)
  } finally {
    await premiumVoice('eleven_multilingual_v2')
  }
})

test('"any language" covers Flux\'s 10 on Deepgram (its default model, Flux), every offered one on another speech recognition', async () => {
  noVoice()
  vi.stubEnv('ELEVENLABS_API_KEY', 'el-test')
  vi.stubEnv('DEEPGRAM_API_KEY', 'dg-test')
  const ws = await createWorkspace('Brightwater Plumbing & Heating')
  const flux = (await act(ws.owner, 'voice.options', {})).body.data
  expect(flux.languages).toContain('pl')
  expect(flux.anyLanguages).toEqual(['en', 'es', 'fr', 'de', 'it', 'pt', 'nl', 'ru', 'hi', 'ja'])
  // No model setting picks Nova any more (decisions.md 2026-11-18): the variable is not read.
  vi.stubEnv('STT_MODEL', 'nova-3')
  expect((await act(ws.owner, 'voice.options', {})).body.data.anyLanguages).toEqual(flux.anyLanguages)
  vi.stubEnv('STT_PROVIDER', 'elevenlabs_stt')
  vi.stubEnv('ELEVENLABS_STT_API_KEY', 'es-test')
  const scribe = (await act(ws.owner, 'voice.options', {})).body.data
  expect(scribe.anyLanguages).toEqual(scribe.languages)
})

test('Mandarin and Korean are offered and can be picked (their test calls passed, LIN-268)', async () => {
  noVoice()
  vi.stubEnv('ELEVENLABS_API_KEY', 'el-test')
  vi.stubEnv('STT_PROVIDER', 'elevenlabs_stt')
  vi.stubEnv('ELEVENLABS_STT_API_KEY', 'es-test')
  const ws = await createWorkspace('Brightwater Plumbing & Heating')
  const options = (await act(ws.owner, 'voice.options', {})).body.data
  expect(options.languages).toEqual(expect.arrayContaining(['zh', 'ko', 'pl']))
  const update = (languages: { main: string; mode: string; allowed: readonly string[] }) =>
    act(ws.owner, 'assistant.update', { assistantId: ws.assistant.id, languages })
  expect((await update({ main: 'en', mode: 'allowed', allowed: ['zh', 'pl'] })).status).toBe(200)
  expect((await update({ main: 'ko', mode: 'english', allowed: [] })).status).toBe(200)
  const [saved] = await db.select().from(assistants).where(eq(assistants.id, ws.assistant.id))
  expect(saved?.languages).toEqual({ main: 'ko', mode: 'english', allowed: [] })
})
