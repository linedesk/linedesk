// More voices: each provider's list read with the install's key, cached, without other workspaces'
// clones or clones made outside Linedesk; picking one of them; its preview.
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CLONE_CONSENT_TEXT, type VoiceCatalogData } from '@linedesk/actions'
import { assistants, voice_clones } from '@linedesk/db'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { Actor } from '../src/context.ts'
import { db } from '../src/db.ts'
import { CATALOG_TTL_MS, catalogCache } from '../src/voice-catalog.ts'
import { cartesiaVoice, elevenLabsVoice, type VoiceProvider } from '../src/voice-provider.ts'
import { hostedSample, previewBudget, previewCache, servePreview } from '../src/voices.ts'
import { act, createWorkspace } from './helpers.ts'

const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(64)])
const SAMPLE_URL = 'https://storage.googleapis.com/eleven-public-prod/library/sample.mp3'
const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 10)
const ids = {
  premade: `premade${suffix}`,
  library: `library${suffix}`,
  ownClone: `ownclone${suffix}`,
  otherClone: `otherclone${suffix}`,
  foreignClone: `foreign${suffix}`,
}

/** ElevenLabs' GET /v2/voices, in two pages, and the hosted sample. */
function fakeElevenLabs() {
  const calls: string[] = []
  const voice = (voice_id: string, category: string, extra: object = {}) => ({
    voice_id,
    name: voice_id,
    category,
    ...extra,
  })
  const fake = vi.fn(async (input: string | URL | Request) => {
    const url = String(input)
    calls.push(url)
    if (url === SAMPLE_URL) return new Response(new Uint8Array(MP3), { headers: { 'content-type': 'audio/mpeg' } })
    if (url.includes('next_page_token=p2'))
      return Response.json({
        voices: [voice(ids.ownClone, 'cloned'), voice(ids.otherClone, 'cloned'), voice(ids.foreignClone, 'cloned')],
        has_more: false,
      })
    return Response.json({
      voices: [
        voice(ids.premade, 'premade', { labels: { gender: 'female', accent: 'american', description: 'warm' } }),
        voice(ids.library, 'generated', { labels: { language: 'de', gender: 'male' }, preview_url: SAMPLE_URL }),
        voice(`pro${suffix}`, 'professional'),
      ],
      has_more: true,
      next_page_token: 'p2',
    })
  })
  return { fake, calls }
}

let elevenlabs: ReturnType<typeof fakeElevenLabs>
beforeEach(() => {
  elevenlabs = fakeElevenLabs()
  vi.stubGlobal('fetch', elevenlabs.fake)
  vi.stubEnv('ELEVENLABS_API_KEY', `key-${suffix}`)
  vi.stubEnv('CARTESIA_API_KEY', '')
  vi.stubEnv('TTS_PROVIDER', 'elevenlabs')
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

const clone = (workspaceId: string, ownerId: string, voiceId: string, deleted = false) =>
  db.insert(voice_clones).values({
    id: `vc_${crypto.randomUUID().slice(0, 12)}`,
    workspace_id: workspaceId,
    provider: 'elevenlabs',
    voice_id: voiceId,
    name: voiceId,
    consent_by: ownerId,
    consent_at: new Date().toISOString(),
    consent_text: CLONE_CONSENT_TEXT,
    deleted_at: deleted ? new Date().toISOString() : null,
  })

test('provider voices are parsed into one shape', () => {
  expect(
    elevenLabsVoice({
      voice_id: 'a1',
      name: 'Ann',
      category: 'premade',
      labels: { gender: 'female', accent: 'british' },
    }),
  ).toEqual({
    id: 'a1',
    name: 'Ann',
    description: null,
    language: 'en',
    gender: 'female',
    accent: 'british',
    previewUrl: null,
    clone: false,
  })
  expect(
    elevenLabsVoice({ voice_id: 'b2', name: 'Bo', category: 'cloned', preview_url: 'http://insecure' }),
  ).toMatchObject({ clone: true, previewUrl: null, language: null })
  expect(elevenLabsVoice({ name: 'no id' })).toBeNull()
  expect(cartesiaVoice({ id: 'c3', name: 'Cy', language: 'en', gender: 'feminine', is_owner: false })).toMatchObject({
    gender: 'female',
    clone: false,
  })
  expect(cartesiaVoice({ id: 'c4', name: 'Own', gender: 'gender_neutral', is_owner: true })).toMatchObject({
    gender: 'neutral',
    clone: true,
  })
})

test('a provider list is read once and reused for a few minutes; a failure is retried sooner', async () => {
  let now = 0
  const cache = catalogCache(() => now)
  let reads = 0
  let fail = false
  const adapter = {
    name: 'elevenlabs',
    listVoices: async () => {
      reads++
      if (fail) throw new Error('down')
      return []
    },
  } as unknown as VoiceProvider
  await cache.voicesOf(adapter, 'k')
  await cache.voicesOf(adapter, 'k')
  expect(reads).toBe(1)
  await cache.voicesOf(adapter, 'another key')
  expect(reads).toBe(2)
  now += CATALOG_TTL_MS + 1
  fail = true
  await expect(cache.voicesOf(adapter, 'k')).rejects.toThrow('down')
  await expect(cache.voicesOf(adapter, 'k')).rejects.toThrow('down')
  expect(reads).toBe(3)
  now += 31_000
  fail = false
  await cache.voicesOf(adapter, 'k')
  expect(reads).toBe(4)
})

test("the catalog lists the providers' voices and the workspace's own clones, never another workspace's or a clone made elsewhere", async () => {
  const ws = await createWorkspace('Catalog Plumbing')
  const other = await createWorkspace('Other Plumbing')
  await clone(ws.id, ws.owner.userId, ids.ownClone)
  await clone(other.id, other.owner.userId, ids.otherClone, true) // released: still not anyone else's
  const { body } = await act(ws.owner, 'voice.catalog', {})
  const data = body.data as VoiceCatalogData
  expect(data.providers).toEqual([
    { provider: 'elevenlabs', label: 'ElevenLabs', active: true, configured: true, error: null },
    { provider: 'cartesia', label: 'Cartesia', active: false, configured: false, error: null },
  ])
  expect(data.voices.map(v => v.id).sort()).toEqual([ids.library, ids.ownClone, ids.premade].sort())
  expect(data.voices.find(v => v.id === ids.premade)).toEqual({
    provider: 'elevenlabs',
    id: ids.premade,
    name: ids.premade,
    description: 'warm',
    language: 'en',
    gender: 'female',
    accent: 'american',
  })
  expect(JSON.stringify(body)).not.toContain(SAMPLE_URL) // samples go through the API
  expect(elevenlabs.calls.every(url => !url.includes('key-'))).toBe(true)
})

test('an assistant can be given a listed voice, not another workspace’s clone', async () => {
  const ws = await createWorkspace('Picker Plumbing')
  const other = await createWorkspace('Neighbour Plumbing')
  await clone(other.id, other.owner.userId, `${ids.otherClone}_live`)
  const pick = (voice_id: string) =>
    act(ws.owner, 'assistant.update', { assistantId: ws.assistant.id, voice: { provider: 'elevenlabs', voice_id } })
  expect((await pick(ids.library)).status).toBe(200)
  const [saved] = await db.select().from(assistants).where(eq(assistants.id, ws.assistant.id))
  expect(saved?.voice).toEqual({ provider: 'elevenlabs', voice_id: ids.library })
  expect((await pick(ids.otherClone)).status).toBeGreaterThanOrEqual(400)
  expect((await pick(`${ids.otherClone}_live`)).status).toBeGreaterThanOrEqual(400)
  expect((await pick(ids.foreignClone)).status).toBeGreaterThanOrEqual(400)
  expect((await pick('NotListedAnywhere123')).status).toBeGreaterThanOrEqual(400)
})

test('a listed voice plays the sample the provider hosts: fetched on the server, no hourly limit', async () => {
  const ws = await createWorkspace('Preview Plumbing')
  const member: Actor = { actorId: ws.owner.userId, role: 'owner', workspaceId: ws.id, permissions: ['call:read'] }
  const cache = previewCache(await mkdtemp(join(tmpdir(), 'catalog-preview-')))
  const options = { cache, budget: previewBudget(0), bundledDir: join(tmpdir(), 'none'), ownClone: false }
  const res = await servePreview(member, ids.library, options)
  expect(res.status).toBe(200)
  expect(Buffer.from(await res.arrayBuffer()).equals(MP3)).toBe(true)
  expect((await servePreview(member, 'NotListedAnywhere123', options)).status).toBe(404)
  expect((await servePreview(member, ids.premade, { ...options, providerName: 'cartesia' })).status).toBe(409) // no Cartesia key
})

test("a hosted sample is fetched only from the provider's sample host and only up to 2 MB", async () => {
  const ok = vi.fn(async () => new Response(new Uint8Array(MP3)))
  expect((await hostedSample('elevenlabs', SAMPLE_URL, ok)).equals(MP3)).toBe(true)
  await expect(hostedSample('elevenlabs', 'https://169.254.169.254/latest/meta-data', ok)).rejects.toThrow(
    /sample host/,
  )
  await expect(hostedSample('elevenlabs', 'http://storage.googleapis.com/x.mp3', ok)).rejects.toThrow(/sample host/)
  await expect(hostedSample('cartesia', SAMPLE_URL, ok)).rejects.toThrow(/sample host/)
  expect(ok).toHaveBeenCalledTimes(1)
  const declared = async () =>
    new Response(new Uint8Array(MP3), { headers: { 'content-length': String(3 * 1024 * 1024) } })
  await expect(hostedSample('elevenlabs', SAMPLE_URL, declared)).rejects.toThrow(/too large/)
  const streamed = async () =>
    new Response(
      new ReadableStream({
        start(c) {
          for (let i = 0; i < 3; i++) c.enqueue(new Uint8Array(1024 * 1024))
          c.close()
        },
      }),
    )
  await expect(hostedSample('elevenlabs', SAMPLE_URL, streamed)).rejects.toThrow(/too large/)
})
