// After-call transcription: the selected provider hears the saved recording again and only the caller's lines change;
// selecting a provider (off until an admin does; a key saved for an active provider can be reused, an inactive key
// never counts) and what a failure leaves. Instance-wide: it sets provider keys and instance_settings
// (vitest.config.ts, INSTANCE_WIDE_FILES).
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { calls, instance_settings, provider_settings, transcript_segments } from '@linedesk/db'
import { asc, eq, isNull, like, or } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import {
  afterCallTranscriptState,
  selectTranscriptProvider,
  transcribeCallAgain,
  transcriberInEffect,
} from '../src/after-call-transcript.ts'
import { db } from '../src/db.ts'
import { createFileRecordingStore } from '../src/recording-store.ts'
import { encryptSecret } from '../src/secrets.ts'
import { type Transcriber, TranscriberError } from '../src/transcriber.ts'
import { act, asServerAdmin, createWorkspace, type Workspace } from './helpers.ts'

let dir: string
let ws: Workspace
const envKeyOnly = { OPENAI_API_KEY: 'sk-test-env-only-0000', TRANSCRIPT_OPENAI_API_KEY: 'sk-test-env-only-0001' }
const noEnv = {}
const ADMIN = 'u_admin'
const NOW = '2026-11-15T20:00:00.000Z'
/** A key stored in Server admin › Providers (the only kind it uses). */
async function storeKey(provider: string) {
  await db.insert(provider_settings).values({
    id: `ps_${provider}`,
    provider,
    field: 'api_key',
    value_encrypted: encryptSecret(`sk-test-${provider}-0000`, `${provider}.api_key`),
  })
}
const storeFor = async () => createFileRecordingStore(dir)

const LINES = [
  { speaker: 'agent', text: 'Thanks for calling Brightwater Plumbing & Heating. How can I help?' },
  { speaker: 'caller', text: 'my water heater is leaking can you send someone' },
  { speaker: 'system', text: 'Took a message' },
  { speaker: 'agent', text: 'Could you please tell me the number to call you back on?' },
  { speaker: 'caller', text: 'five oh three five five five oh one four two' },
  { speaker: 'agent', text: 'Thank you. The team will get back to you soon.' },
] as const
const HEARD =
  'Thanks for calling Brightwater Plumbing and Heating. How can I help? My water heater is leaking. Can you send someone? Could you please tell me the number to call you back on? 503-555-0142. Thank you. The team will get back to you soon.'

function fakeTranscriber(answer: string | Error, maxBytes = 1000): Transcriber & { heard: Blob[] } {
  const heard: Blob[] = []
  return {
    model: 'gpt-transcribe',
    maxBytes,
    heard,
    async transcribe(audio) {
      heard.push(audio)
      if (answer instanceof Error) throw answer
      return { text: answer }
    },
  }
}

const linesOf = async () =>
  db
    .select({ speaker: transcript_segments.speaker, text: transcript_segments.text })
    .from(transcript_segments)
    .where(eq(transcript_segments.call_id, ws.call.id))
    .orderBy(asc(transcript_segments.at_ms))

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'linedesk-after-call-'))
  ws = await createWorkspace('Brightwater Plumbing & Heating')
  const key = `${ws.id}/${ws.call.id}.ogg`
  await mkdir(dirname(join(dir, key)), { recursive: true })
  await writeFile(join(dir, key), Uint8Array.from([1, 2, 3, 4]))
  await db
    .update(calls)
    .set({ status: 'completed', recording_key: key, recording_store: 'file' })
    .where(eq(calls.id, ws.call.id))
})
afterAll(() => rm(dir, { recursive: true, force: true }))

beforeEach(async () => {
  await db
    .delete(instance_settings)
    .where(or(like(instance_settings.key, 'active_provider.%'), like(instance_settings.key, 'key_from.%')))
  await db.delete(provider_settings).where(isNull(provider_settings.workspace_id))
  await db.delete(transcript_segments).where(eq(transcript_segments.call_id, ws.call.id))
  await db.insert(transcript_segments).values(
    LINES.map((line, i) => ({
      id: `seg_${ws.call.id}_${i}`,
      workspace_id: ws.id,
      call_id: ws.call.id,
      speaker: line.speaker,
      text: line.text,
      at_ms: i * 1000,
    })),
  )
  await db.update(calls).set({ status: 'completed' }).where(eq(calls.id, ws.call.id))
})

test("the recording is heard again: only the caller's lines change, the assistant's and the tool lines stay", async () => {
  const transcriber = fakeTranscriber(HEARD)
  expect(await transcribeCallAgain(db, ws.call.id, transcriber, storeFor)).toEqual({
    status: 'updated',
    lines: 2,
    model: 'gpt-transcribe',
  })
  expect(new Uint8Array(await transcriber.heard[0]!.arrayBuffer())).toEqual(Uint8Array.from([1, 2, 3, 4]))
  expect(transcriber.heard[0]!.type).toBe('audio/ogg')
  expect(await linesOf()).toEqual([
    LINES[0],
    { speaker: 'caller', text: 'My water heater is leaking. Can you send someone?' },
    LINES[2],
    LINES[3],
    { speaker: 'caller', text: '503-555-0142.' },
    LINES[5],
  ])
})

test('switched off or no model: nothing is heard, nothing changes', async () => {
  expect(await transcribeCallAgain(db, ws.call.id, null, storeFor)).toEqual({ status: 'skipped', reason: 'off' })
  expect(await linesOf()).toEqual(LINES.map(l => ({ ...l })))
})

test('a failing model leaves the live transcript as it is (the job tries again)', async () => {
  await expect(
    transcribeCallAgain(db, ws.call.id, fakeTranscriber(new Error('transcription failed (500)')), storeFor),
  ).rejects.toThrow(/500/)
  expect(await linesOf()).toEqual(LINES.map(l => ({ ...l })))
})

test('a recording larger than the model takes, or a request it refuses for good, is skipped without a retry', async () => {
  const small = fakeTranscriber(HEARD, 2)
  expect(await transcribeCallAgain(db, ws.call.id, small, storeFor)).toEqual({ status: 'skipped', reason: 'too large' })
  expect(small.heard).toHaveLength(0)
  const refused = fakeTranscriber(new TranscriberError(401, 'Incorrect API key'))
  expect(await transcribeCallAgain(db, ws.call.id, refused, storeFor)).toEqual({ status: 'skipped', reason: 'refused' })
  expect(await linesOf()).toEqual(LINES.map(l => ({ ...l })))
})

test('a text that does not fit the call is not trusted', async () => {
  const result = await transcribeCallAgain(db, ws.call.id, fakeTranscriber('Some other recording entirely.'), storeFor)
  expect(result).toEqual({ status: 'skipped', reason: 'not trusted' })
  expect(await linesOf()).toEqual(LINES.map(l => ({ ...l })))
})

test('a call still live is tried again later; a call without a recording is skipped', async () => {
  await db.update(calls).set({ status: 'live' }).where(eq(calls.id, ws.call.id))
  await expect(transcribeCallAgain(db, ws.call.id, fakeTranscriber(HEARD), storeFor)).rejects.toThrow(/still live/)
  await db.update(calls).set({ status: 'completed', recording_key: null }).where(eq(calls.id, ws.call.id))
  expect(await transcribeCallAgain(db, ws.call.id, fakeTranscriber(HEARD), storeFor)).toEqual({
    status: 'skipped',
    reason: 'no recording',
  })
  await db
    .update(calls)
    .set({ recording_key: `${ws.id}/${ws.call.id}.ogg` })
    .where(eq(calls.id, ws.call.id))
})

const optionOf = async (provider: string, env = noEnv) =>
  (await afterCallTranscriptState(db, env)).options.find(o => o.provider === provider)

test('off until an admin selects a provider; a key only in .env never counts', async () => {
  for (const env of [noEnv, envKeyOnly]) {
    const state = await afterCallTranscriptState(db, env)
    expect(state.selected).toBeNull()
    expect(state.options.map(o => [o.provider, o.state])).toEqual([
      ['openai_transcript', 'none'],
      ['deepgram_transcript', 'none'],
      ['assemblyai', 'none'],
      ['elevenlabs_transcript', 'none'],
    ])
    expect(await transcriberInEffect(db, env)).toBeNull()
  }
})

test('a key saved for an active provider is selected with one click; an inactive key never counts', async () => {
  // Deepgram is the active speech to text: its key can be reused. Nothing runs until it is selected.
  await storeKey('deepgram')
  expect(await optionOf('deepgram_transcript')).toMatchObject({ state: 'reusable', reuseFrom: 'deepgram' })
  expect(await transcriberInEffect(db, noEnv)).toBeNull()

  // An OpenAI key stored for a language model that is not the active one: not offered, and refused.
  await storeKey('openai')
  await db.insert(instance_settings).values({ key: 'active_provider.llm', value: 'anthropic' })
  expect(await optionOf('openai_transcript')).toMatchObject({ state: 'none', reuseFrom: null })
  await expect(selectTranscriptProvider(db, 'openai_transcript', ADMIN, NOW, noEnv)).rejects.toThrow(/key first/)

  await selectTranscriptProvider(db, 'deepgram_transcript', ADMIN, NOW, noEnv)
  expect(await optionOf('deepgram_transcript')).toMatchObject({ state: 'in_use' })
  expect((await afterCallTranscriptState(db, noEnv)).selected).toBe('deepgram_transcript')
  expect((await transcriberInEffect(db, noEnv))?.model).toBe('nova-3')
  // A reference to the stored key, not a copy.
  const [link] = await db
    .select()
    .from(instance_settings)
    .where(eq(instance_settings.key, 'key_from.deepgram_transcript'))
  expect(link?.value).toBe('deepgram')

  await selectTranscriptProvider(db, null, ADMIN, NOW, noEnv)
  expect(await transcriberInEffect(db, noEnv)).toBeNull()
})

test("the realtime model's OpenAI key serves OpenAI transcription", async () => {
  await storeKey('openai_realtime')
  expect(await optionOf('openai_transcript')).toMatchObject({ state: 'reusable', reuseFrom: 'openai_realtime' })
  await selectTranscriptProvider(db, 'openai_transcript', ADMIN, NOW, noEnv)
  expect((await transcriberInEffect(db, noEnv))?.model).toBe('gpt-transcribe')
})

test('a provider connected with its own key; removing the key stops it', async () => {
  await storeKey('assemblyai')
  expect(await optionOf('assemblyai')).toMatchObject({ state: 'connected' })
  await selectTranscriptProvider(db, 'assemblyai', ADMIN, NOW, noEnv)
  expect((await transcriberInEffect(db, noEnv))?.model).toBe('universal')
  await db.delete(provider_settings).where(eq(provider_settings.provider, 'assemblyai'))
  expect(await transcriberInEffect(db, noEnv)).toBeNull()
  expect((await afterCallTranscriptState(db, noEnv)).selected).toBeNull()
})

test('the generic provider switch never selects it: only its own action does', async () => {
  await storeKey('assemblyai')
  await asServerAdmin(ws.owner, async () => {
    const res = await act(ws.owner, 'provider.setActive', { category: 'transcript', provider: 'assemblyai' })
    expect(res.status).toBe(409)
    expect((await act(ws.owner, 'afterCallTranscript.set', { provider: 'assemblyai' })).status).toBe(200)
  })
  expect((await transcriberInEffect(db, noEnv))?.model).toBe('universal')
})

test('only an instance admin reads or sets it', async () => {
  expect((await act(ws.owner, 'afterCallTranscript.get', {})).status).toBe(403)
  expect((await act(ws.owner, 'afterCallTranscript.set', { provider: null })).status).toBe(403)
})
