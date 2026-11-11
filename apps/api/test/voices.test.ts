// Voices: previews (once per voice, only voices the workspace may use, a budget for new ones, a
// bounded cache), cloning (off by default, outside the transaction, magic bytes, consent stored,
// clones released at the provider), and which voices an assistant may be given.
import { mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { actions, CLONE_CONSENT_TEXT, curatedVoices, rolePermissions, voiceClone } from '@linedesk/actions'
import { assistants, commands, instance_settings, voice_clones } from '@linedesk/db'
import { and, eq } from 'drizzle-orm'
import { afterEach, beforeAll, expect, test, vi } from 'vitest'
import type { Actor } from '../src/context.ts'
import { db } from '../src/db.ts'
import { runHandler } from '../src/handlers.ts'
import { createVoiceProvider, type VoiceProvider, VoiceProviderError } from '../src/voice-provider.ts'
import {
  audioKind,
  bundledPreview,
  NO_PROVIDER_FOR_PREVIEW,
  PREVIEW_TEXT,
  previewBudget,
  previewCache,
  releaseWorkspaceClones,
  servePreview,
} from '../src/voices.ts'
import { act, createWorkspace, type Workspace } from './helpers.ts'

const member: Actor = { actorId: 'u_1', role: 'member', workspaceId: 'ws_1', permissions: rolePermissions.member }
const JESSICA = curatedVoices.elevenlabs![0]!.id
const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt '), Buffer.alloc(64)])

function fakeProvider(fail?: VoiceProviderError) {
  const made: string[] = []
  const provider: VoiceProvider = {
    name: 'elevenlabs',
    model: 'eleven_flash_v2_5',
    async synthesize(voiceId, text) {
      made.push(`${voiceId}:${text}`)
      if (fail) throw fail
      return { bytes: Buffer.from(`mp3 of ${voiceId}`), contentType: 'audio/mpeg' }
    },
    async listVoices() {
      return []
    },
  }
  return { provider, made }
}
const cacheDir = () => mkdtemp(join(tmpdir(), 'voice-preview-test-'))
const unlimited = () => previewBudget(1000)
/** No shipped samples: the tests below exercise synthesis and the cache. */
const NONE = join(tmpdir(), 'no-bundled-voice-previews')

test('every curated voice has a shipped sample: it plays without a provider key and never calls the provider', async () => {
  const { provider, made } = fakeProvider()
  for (const { id } of Object.values(curatedVoices).flat()) {
    const shipped = await bundledPreview(id)
    expect(shipped && audioKind(shipped), id).toBe('mp3')
    for (const p of [null, provider]) {
      const res = await servePreview(member, id, {
        provider: p,
        cache: previewCache(await cacheDir()),
        budget: previewBudget(0),
      })
      expect(res.status, id).toBe(200)
      expect(res.headers.get('content-type')).toBe('audio/mpeg')
      expect(Buffer.from(await res.arrayBuffer()).equals(shipped!)).toBe(true)
    }
  }
  expect(made).toEqual([])
})

test('a sample that has to be made without a provider says how to add one', async () => {
  const res = await servePreview(member, 'MyOwnClone12345', { provider: null, ownClone: true, bundledDir: NONE })
  expect(res.status).toBe(409)
  expect(((await res.json()) as { error: string }).error).toBe(NO_PROVIDER_FOR_PREVIEW)
})

test('a preview is synthesized once and then served from the cache, also to the next page view', async () => {
  const { provider, made } = fakeProvider()
  const cache = previewCache(await cacheDir())
  const first = await servePreview(member, JESSICA, { provider, cache, budget: unlimited(), bundledDir: NONE })
  expect(first.status).toBe(200)
  expect(first.headers.get('cache-control')).toContain('immutable')
  expect(Buffer.from(await first.arrayBuffer()).toString()).toBe(`mp3 of ${JESSICA}`)
  expect((await servePreview(member, JESSICA, { provider, cache, budget: unlimited(), bundledDir: NONE })).status).toBe(
    200,
  )
  expect(made).toEqual([`${JESSICA}:${PREVIEW_TEXT}`])
})

test('two requests at once share one synthesis', async () => {
  const { provider, made } = fakeProvider()
  const cache = previewCache(await cacheDir())
  const both = await Promise.all(
    [1, 2].map(() => servePreview(member, JESSICA, { provider, cache, budget: unlimited(), bundledDir: NONE })),
  )
  expect(both.map(r => r.status)).toEqual([200, 200])
  expect(made).toHaveLength(1)
})

test('only curated voices and the workspace’s own clones have a preview; malformed ids and no provider are refused', async () => {
  const { provider, made } = fakeProvider()
  const cache = previewCache(await cacheDir())
  const options = { provider, cache, budget: unlimited(), bundledDir: NONE }
  expect(
    (await servePreview(member, 'SomeOtherVoice123', { ...options, ownClone: false, catalogEntry: null })).status,
  ).toBe(404)
  expect((await servePreview(member, 'MyOwnClone12345', { ...options, ownClone: true })).status).toBe(200)
  expect((await servePreview(member, '../../etc/passwd', options)).status).toBe(400)
  expect((await servePreview(member, JESSICA, { ...options, provider: null })).status).toBe(409)
  expect((await servePreview({ ...member, workspaceId: null }, JESSICA, options)).status).toBe(403)
  expect(made).toEqual([`MyOwnClone12345:${PREVIEW_TEXT}`])
})

test('new samples per workspace are limited per hour; cached ones are not', async () => {
  const { provider } = fakeProvider()
  const cache = previewCache(await cacheDir())
  const budget = previewBudget(2)
  const voices = curatedVoices.elevenlabs!.map(v => v.id)
  expect((await servePreview(member, voices[0]!, { provider, cache, budget, bundledDir: NONE })).status).toBe(200)
  expect((await servePreview(member, voices[1]!, { provider, cache, budget, bundledDir: NONE })).status).toBe(200)
  expect((await servePreview(member, voices[2]!, { provider, cache, budget, bundledDir: NONE })).status).toBe(429)
  expect((await servePreview(member, voices[0]!, { provider, cache, budget, bundledDir: NONE })).status).toBe(200) // cached
  expect(
    (await servePreview({ ...member, workspaceId: 'ws_2' }, voices[2]!, { provider, cache, budget, bundledDir: NONE }))
      .status,
  ).toBe(200)
})

test('the preview cache keeps only the newest samples', async () => {
  const dir = await cacheDir()
  const cache = previewCache(dir, 3)
  for (let i = 0; i < 5; i++) {
    await cache.put(`key${i}`, Buffer.from(String(i)))
    await new Promise(r => setTimeout(r, 15))
  }
  expect((await readdir(dir)).sort()).toEqual(['key2.mp3', 'key3.mp3', 'key4.mp3'])
})

test('a voice the provider does not know is a 404, not cached', async () => {
  const { provider, made } = fakeProvider(new VoiceProviderError('voice preview failed (404): voice not found', 404))
  const cache = previewCache(await cacheDir())
  const options = { provider, cache, budget: unlimited(), ownClone: true, bundledDir: NONE }
  expect((await servePreview(member, 'UnknownVoice123', options)).status).toBe(404)
  expect((await servePreview(member, 'UnknownVoice123', options)).status).toBe(404)
  expect(made).toHaveLength(2)
})

test('ElevenLabs: preview with the fast model; clone sends the recording as a file; delete', async () => {
  const sent: { url: string; init: RequestInit }[] = []
  const fakeFetch: typeof fetch = async (url, init) => {
    sent.push({ url: String(url), init: init! })
    if (String(url).endsWith('/voices/add')) return Response.json({ voice_id: 'cloned_voice_1' })
    if (init?.method === 'DELETE') return new Response(null, { status: 404 })
    return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'audio/mpeg' } })
  }
  const eleven = createVoiceProvider('elevenlabs', { api_key: 'KEY' }, fakeFetch)!
  expect((await eleven.synthesize(JESSICA, 'Hello')).bytes).toHaveLength(3)
  expect(sent[0]!.url).toBe(`https://api.elevenlabs.io/v1/text-to-speech/${JESSICA}?output_format=mp3_44100_64`)
  expect(JSON.parse(String(sent[0]!.init.body))).toEqual({ text: 'Hello', model_id: 'eleven_flash_v2_5' })
  expect(await eleven.cloneVoice!({ name: "Mike's voice", audio: WAV, mimeType: 'audio/wav' })).toBe('cloned_voice_1')
  expect(((sent[1]!.init.body as FormData).get('files') as File).type).toBe('audio/wav')
  await eleven.deleteVoice!('cloned_voice_1') // already gone (404) is fine
  expect(sent[2]).toMatchObject({
    url: 'https://api.elevenlabs.io/v1/voices/cloned_voice_1',
    init: { method: 'DELETE' },
  })
  expect(createVoiceProvider('cartesia', { api_key: 'KEY' })?.cloneVoice).toBeUndefined()
})

test('magic bytes: the recording has to be the audio it claims to be', () => {
  expect(audioKind(WAV)).toBe('wav')
  expect(audioKind(Buffer.concat([Buffer.from('ID3'), Buffer.alloc(20)]))).toBe('mp3')
  expect(audioKind(Buffer.concat([Buffer.from('OggS'), Buffer.alloc(20)]))).toBe('ogg')
  expect(audioKind(Buffer.concat([Buffer.alloc(4), Buffer.from('ftypM4A '), Buffer.alloc(20)]))).toBe('mp4')
  expect(audioKind(Buffer.from('%PDF-1.7 not audio at all'))).toBeNull()
})

test('voice actions: registry entries', () => {
  expect(actions.get('voice.options')).toMatchObject({ permission: 'call:read', readOnly: true })
  expect(voiceClone).toMatchObject({ permission: 'settings:write', sensitive: ['audio'] })
  expect(actions.get('voiceCloning.set')?.permission).toBe('instance:admin')
  expect(actions.get('voiceCloning.get')).toMatchObject({ permission: 'instance:admin', readOnly: true })
  const base = { assistantId: 'as_1', name: 'Mike', audio: 'UklGRg==', mimeType: 'audio/wav' }
  expect(voiceClone.input.safeParse({ ...base, consent: true }).success).toBe(true)
  expect(voiceClone.input.safeParse({ ...base, consent: false }).success).toBe(false)
  expect(voiceClone.input.safeParse({ ...base, consent: true, mimeType: 'application/pdf' }).success).toBe(false)
})

// --- Through the API, with a mocked ElevenLabs

let ws: Workspace
let other: Workspace
const providerCalls: { url: string; method: string }[] = []
let cloned = 0

beforeAll(async () => {
  ws = await createWorkspace('Voice Plumbing')
  other = await createWorkspace('Other Voices')
})

function mockElevenLabs() {
  vi.stubEnv('ELEVENLABS_API_KEY', 'test-key')
  vi.stubEnv('TTS_PROVIDER', 'elevenlabs')
  const real = globalThis.fetch
  vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url)
    if (!href.startsWith('https://api.elevenlabs.io')) return real(url, init)
    providerCalls.push({ url: href, method: init?.method ?? 'GET' })
    if (href.endsWith('/voices/add')) return Response.json({ voice_id: `clone_${++cloned}_abcdef` })
    return new Response(null, { status: 200 })
  })
}
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

const setCloning = (on: boolean) =>
  db
    .insert(instance_settings)
    .values({ key: 'voice_cloning', value: on ? 'on' : 'off' })
    .onConflictDoUpdate({ target: instance_settings.key, set: { value: on ? 'on' : 'off' } })
const cloneInput = (assistantId: string, audio = WAV) => ({
  assistantId,
  name: "Mike's voice",
  consent: true,
  audio: audio.toString('base64'),
  mimeType: 'audio/wav',
})

test('cloning is off by default: refused, and nothing reaches the provider', async () => {
  mockElevenLabs()
  await setCloning(false)
  const res = await act(ws.owner, 'voice.clone', cloneInput(ws.assistant.id))
  expect(res).toMatchObject({ status: 409, body: { error: expect.stringMatching(/turned off/) } })
  expect(providerCalls.filter(c => c.url.endsWith('/voices/add'))).toEqual([])
  expect((await act(ws.owner, 'voice.options', {})).body.data).toMatchObject({
    provider: 'elevenlabs',
    canClone: false,
  })
})

test('a file that is not the audio it claims is refused before the provider is asked', async () => {
  mockElevenLabs()
  await setCloning(true)
  const res = await act(
    ws.owner,
    'voice.clone',
    cloneInput(ws.assistant.id, Buffer.from('%PDF-1.7 this is a document, not audio')),
  )
  expect(res).toMatchObject({ status: 409, body: { error: 'the file is not the audio recording it says it is' } })
  expect(providerCalls.filter(c => c.url.endsWith('/voices/add'))).toEqual([])
})

test('a clone stores the consent, becomes the assistant’s voice, and the old clone is deleted at the provider when replaced', async () => {
  mockElevenLabs()
  await setCloning(true)
  const first = await act(ws.owner, 'voice.clone', cloneInput(ws.assistant.id))
  expect(first.status).toBe(200)
  const voiceId = first.body.data.voiceId as string
  const [row] = await db.select().from(voice_clones).where(eq(voice_clones.voice_id, voiceId))
  expect(row).toMatchObject({
    workspace_id: ws.id,
    provider: 'elevenlabs',
    consent_text: CLONE_CONSENT_TEXT,
    consent_by: ws.owner.userId,
  })
  expect(row?.consent_at).toBeTruthy()
  const [assistant] = await db.select().from(assistants).where(eq(assistants.id, ws.assistant.id))
  expect(assistant?.voice).toEqual({ provider: 'elevenlabs', voice_id: voiceId })
  // The recording never reaches the command log.
  const [logged] = await db
    .select()
    .from(commands)
    .where(and(eq(commands.action, 'voice.clone'), eq(commands.workspace_id, ws.id)))
  expect(JSON.stringify(logged?.input)).not.toContain(WAV.toString('base64'))
  expect((await act(ws.owner, 'voice.options', {})).body.data.clones).toEqual([{ id: voiceId, name: "Mike's voice" }])

  // Back to a curated voice: the clone is released (here; the provider deletion is a queued job).
  const back = await act(ws.owner, 'assistant.update', {
    assistantId: ws.assistant.id,
    voice: { provider: 'elevenlabs', voice_id: JESSICA },
  })
  expect(back.status).toBe(200)
  // The row stays as the consent record, marked deleted; the clone is no longer offered or allowed.
  const [kept] = await db.select().from(voice_clones).where(eq(voice_clones.voice_id, voiceId))
  expect(kept).toMatchObject({ consent_text: CLONE_CONSENT_TEXT, consent_by: ws.owner.userId })
  expect(kept?.deleted_at).toBeTruthy()
  expect((await act(ws.owner, 'voice.options', {})).body.data.clones).toEqual([])
  const reuse = await act(ws.owner, 'assistant.update', {
    assistantId: ws.assistant.id,
    voice: { provider: 'elevenlabs', voice_id: voiceId },
  })
  expect(reuse.status).toBe(409)
})

test('an assistant may only get curated voices or its own workspace’s clones', async () => {
  mockElevenLabs()
  await setCloning(true)
  const theirs = (await act(other.owner, 'voice.clone', cloneInput(other.assistant.id))).body.data.voiceId as string
  const set = (voice_id: string) =>
    act(ws.owner, 'assistant.update', { assistantId: ws.assistant.id, voice: { provider: 'elevenlabs', voice_id } })
  expect((await set(theirs)).status).toBe(409)
  expect((await set('RandomVoiceId123')).status).toBe(409)
  expect((await set(JESSICA)).status).toBe(200)
  expect((await set('')).status).toBe(200)
  // Other fields still update as before.
  expect(
    (await act(ws.owner, 'assistant.update', { assistantId: ws.assistant.id, greeting: 'Hello there.' })).body.rows
      .assistants,
  ).toMatchObject([{ greeting: 'Hello there.' }])
})

test('the clone recording body is capped before it is parsed', async () => {
  const huge = 'x'.repeat(15 * 1024 * 1024)
  const res = await act(ws.owner, 'voice.clone', {
    assistantId: ws.assistant.id,
    name: 'Big',
    consent: true,
    audio: huge,
    mimeType: 'audio/wav',
  })
  expect(res.status).toBe(413)
})

test('the instance switch: voiceCloning.get and .set', async () => {
  const admin: Actor = { actorId: 'u_admin', role: 'owner', workspaceId: null, permissions: ['instance:admin'] }
  const run = (name: string, input: unknown) =>
    runHandler({ tx: db, actor: admin, now: new Date().toISOString() }, actions.get(name)!, input)
  expect((await run('voiceCloning.set', { on: false })).data).toEqual({ on: false })
  expect((await run('voiceCloning.get', {})).data).toEqual({ on: false })
  expect((await run('voiceCloning.set', { on: true })).data).toEqual({ on: true })
  expect((await run('voiceCloning.get', {})).data).toEqual({ on: true })
})

test('cache prune leaves other files alone', async () => {
  const dir = await cacheDir()
  await writeFile(join(dir, 'notes.txt'), 'keep')
  const cache = previewCache(dir, 1)
  await cache.put('a', Buffer.from('a'))
  await cache.put('b', Buffer.from('b'))
  expect((await readdir(dir)).sort()).toContain('notes.txt')
})

test('deleting a workspace releases all its clones; the consent records stay', async () => {
  const gone = await createWorkspace('Closing Down')
  await db.insert(voice_clones).values({
    id: `vc_${crypto.randomUUID().slice(0, 8)}`,
    workspace_id: gone.id,
    provider: 'elevenlabs',
    voice_id: `clone_closing_${Date.now()}`,
    name: 'Old',
    consent_by: gone.owner.userId,
    consent_at: new Date().toISOString(),
    consent_text: CLONE_CONSENT_TEXT,
  })
  const released = await db.transaction(tx => releaseWorkspaceClones(tx, gone.id))
  expect(released).toHaveLength(1)
  const rows = await db.select().from(voice_clones).where(eq(voice_clones.workspace_id, gone.id))
  expect(rows).toHaveLength(1)
  expect(rows[0]?.deleted_at).toBeTruthy()
  // Released once: a second release finds nothing left to delete at the provider.
  expect(await db.transaction(tx => releaseWorkspaceClones(tx, gone.id))).toEqual([])
})
