// After-call transcription: the picked service hears the saved recording again and only the caller's lines change;
// picking a service (off until an admin does; it uses the key connected for that service under Providers, a key only
// in .env never counts) and what a failure leaves. Instance-wide: it sets provider keys and instance_settings
// (vitest.config.ts, INSTANCE_WIDE_FILES).
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  appointment_types,
  assistants,
  calls,
  contacts,
  instance_settings,
  provider_settings,
  transcript_segments,
} from '@linedesk/db'
import { asc, eq, isNull, like, or } from 'drizzle-orm'
import type { PgBoss } from 'pg-boss'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import {
  afterCallTranscriptState,
  AFTER_CALL_TRANSCRIPT_SETTING,
  selectTranscriptService,
  transcribeCallAgain,
  transcriberInEffect,
} from '../src/after-call-transcript.ts'
import { db } from '../src/db.ts'
import { createFileRecordingStore } from '../src/recording-store.ts'
import { encryptSecret } from '../src/secrets.ts'
import { type Transcriber, TranscriberError } from '../src/transcriber.ts'
import { releaseHeldNews } from '../src/call-news.ts'
import { transcriptHints } from '../src/transcript-hints.ts'
import { CALL_NOTIFY, CALL_RELEASE, CALL_TRANSCRIBE, setJobQueue } from '../src/jobs.ts'
import { act, agent, asServerAdmin, createWorkspace, getCall, randomNumber, type Workspace } from './helpers.ts'

let dir: string
let ws: Workspace
const envKeyOnly = { OPENAI_API_KEY: 'sk-test-env-only-0000', DEEPGRAM_API_KEY: 'sk-test-env-only-0001' }
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

function fakeTranscriber(answer: string | Error, maxBytes = 1000): Transcriber & { heard: Blob[]; hints: unknown[] } {
  const heard: Blob[] = []
  const hints: unknown[] = []
  return {
    model: 'gpt-transcribe',
    maxBytes,
    heard,
    hints,
    async transcribe(audio, _file, given) {
      heard.push(audio)
      hints.push(given)
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
    .where(
      or(
        like(instance_settings.key, 'active_provider.%'),
        like(instance_settings.key, 'key_from.%'),
        eq(instance_settings.key, AFTER_CALL_TRANSCRIPT_SETTING),
      ),
    )
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

const optionOf = async (service: string, env = noEnv) =>
  (await afterCallTranscriptState(db, env)).options.find(o => o.service === service)

test('off until an admin picks a service; a key only in .env never counts', async () => {
  for (const env of [noEnv, envKeyOnly]) {
    const state = await afterCallTranscriptState(db, env)
    expect(state.selected).toBeNull()
    expect(state.options.map(o => [o.service, o.state, o.connectAt])).toEqual([
      ['elevenlabs', 'none', 'elevenlabs_stt'],
      ['openai', 'none', 'openai_stt'],
      ['deepgram', 'none', 'deepgram'],
      ['assemblyai', 'none', 'assemblyai_stt'],
    ])
    expect(await transcriberInEffect(db, env)).toBeNull()
    await expect(selectTranscriptService(db, 'deepgram', ADMIN, NOW, env)).rejects.toThrow(/under Providers first/)
  }
})

test('a service connected under Providers is picked and uses that key; removing the key stops it', async () => {
  // Deepgram connected once, for speech to text: after-call transcription can use it, but nothing runs until picked.
  await storeKey('deepgram')
  expect(await optionOf('deepgram')).toMatchObject({ state: 'connected', keyFrom: 'deepgram' })
  expect(await transcriberInEffect(db, noEnv)).toBeNull()

  await selectTranscriptService(db, 'deepgram', ADMIN, NOW, noEnv)
  expect(await optionOf('deepgram')).toMatchObject({ state: 'in_use' })
  expect((await afterCallTranscriptState(db, noEnv)).selected).toBe('deepgram')
  expect((await transcriberInEffect(db, noEnv))?.model).toBe('nova-3')
  // No key of its own and no link: the speech to text key is the one key.
  const links = await db.select().from(instance_settings).where(like(instance_settings.key, 'key_from.%'))
  expect(links).toEqual([])

  await db.delete(provider_settings).where(eq(provider_settings.provider, 'deepgram'))
  expect(await transcriberInEffect(db, noEnv)).toBeNull()
  expect((await afterCallTranscriptState(db, noEnv)).selected).toBeNull()
})

test('any connected provider of the service counts, active or not, in the registry order', async () => {
  // OpenAI connected only for the realtime model, ElevenLabs only for the voice, AssemblyAI for speech to text.
  await storeKey('openai_realtime')
  await storeKey('elevenlabs')
  await storeKey('assemblyai_stt')
  expect(await optionOf('openai')).toMatchObject({ state: 'connected', keyFrom: 'openai_realtime' })
  expect(await optionOf('elevenlabs')).toMatchObject({ state: 'connected', keyFrom: 'elevenlabs' })
  expect(await optionOf('assemblyai')).toMatchObject({ state: 'connected', keyFrom: 'assemblyai_stt' })
  // ElevenLabs speech to text connected too: its key comes first.
  await storeKey('elevenlabs_stt')
  expect(await optionOf('elevenlabs')).toMatchObject({ keyFrom: 'elevenlabs_stt' })

  await selectTranscriptService(db, 'openai', ADMIN, NOW, noEnv)
  expect((await transcriberInEffect(db, noEnv))?.model).toBe('gpt-transcribe')
  await selectTranscriptService(db, 'elevenlabs', ADMIN, NOW, noEnv)
  expect((await transcriberInEffect(db, noEnv))?.model).toBe('scribe_v2')
  await selectTranscriptService(db, null, ADMIN, NOW, noEnv)
  expect(await transcriberInEffect(db, noEnv)).toBeNull()
})

test('the action picks a service; the old transcript provider category is gone', async () => {
  await storeKey('assemblyai_stt')
  await asServerAdmin(ws.owner, async () => {
    expect((await act(ws.owner, 'provider.setActive', { category: 'transcript', provider: 'assemblyai' })).status).toBe(
      422,
    )
    const res = await act(ws.owner, 'afterCallTranscript.set', { service: 'assemblyai' })
    expect(res.status).toBe(200)
    expect(res.body.data.selected).toBe('assemblyai')
  })
  expect((await transcriberInEffect(db, noEnv))?.model).toBe('universal')
})

test('only an instance admin reads or sets it', async () => {
  expect((await act(ws.owner, 'afterCallTranscript.get', {})).status).toBe(403)
  expect((await act(ws.owner, 'afterCallTranscript.set', { service: null })).status).toBe(403)
})

// The call's news waits for the corrected transcript (call-news.ts): call.finish holds it, call.finalize or the
// CALL_RELEASE job sends it.
const sent = vi.fn(async (_name: string, _data: object, _options: object) => 'job-id')
const jobsNamed = (name: string) => sent.mock.calls.filter(([n]) => n === name)
afterEach(() => vi.unstubAllGlobals())

async function liveCall(lines: readonly { speaker: string; text: string }[] = LINES) {
  setJobQueue({ send: sent } as unknown as PgBoss)
  sent.mockClear()
  const { body } = await act(agent(), 'call.start', { from: randomNumber(), to: ws.number })
  const callId: string = body.data.callId
  for (const [i, line] of lines.entries())
    await act(agent(ws.id), 'call.appendTranscript', { callId, speaker: line.speaker, text: line.text, atMs: i * 1000 })
  return callId
}

async function transcriptionOn() {
  await storeKey('openai_realtime')
  await selectTranscriptService(db, 'openai', ADMIN, NOW, noEnv)
}

const first = {
  title: 'Call in Korean',
  summary: 'The caller spoke Korean.',
  outcome: 'answered',
  actionItems: [{ text: 'Find someone who speaks Korean' }],
}

test('after-call transcription on: call.finish holds the news until call.finalize brings the better summary', async () => {
  await transcriptionOn()
  const callId = await liveCall()
  const finished = await act(agent(ws.id), 'call.finish', { callId, ...first, awaitTranscript: true })
  expect(finished.body.data).toEqual({ held: true, named: false })
  // A retried finish (its answer was lost) gets the same hold.
  expect((await act(agent(ws.id), 'call.finish', { callId, ...first, awaitTranscript: true })).body.data.held).toBe(
    true,
  )
  const held = (await getCall(callId))!
  expect(held.status).toBe('completed')
  expect(held.awaiting_transcript_until).not.toBeNull()
  expect(jobsNamed(CALL_NOTIFY)).toHaveLength(0)
  expect(jobsNamed(CALL_RELEASE)[0]!.slice(0, 2)).toEqual([CALL_RELEASE, { callId }])

  // The recording comes in: the agent asks for the transcript itself, no job.
  await act(agent(ws.id), 'call.setRecording', { callId, store: 'file' })
  expect(jobsNamed(CALL_TRANSCRIBE)).toHaveLength(0)

  // A note the team added meanwhile stays; the first summary's item goes.
  await db
    .update(calls)
    .set({ action_items: [...held.action_items, { text: 'Team note' }], missing_info: ['callback_number'] })
    .where(eq(calls.id, callId))
  const done = await act(agent(ws.id), 'call.finalize', {
    callId,
    title: 'Water heater leak',
    summary: 'The water heater is leaking.',
    outcome: 'callback',
    actionItems: [{ text: 'Call back about the water heater' }],
    // The corrected transcript has the number the first summary missed: the flag goes (LIN-513).
    missing: [],
    previous: { actionItems: ['Find someone who speaks Korean'] },
  })
  expect(done.status).toBe(200)
  const final = (await getCall(callId))!
  expect(final).toMatchObject({
    title: 'Water heater leak',
    outcome: 'callback',
    awaiting_transcript_until: null,
    missing_info: [],
  })
  expect(final.action_items.map((item: { text: string }) => item.text)).toEqual([
    'Call back about the water heater',
    'Team note',
  ])
  expect(jobsNamed(CALL_NOTIFY)).toHaveLength(1)

  // Once: a repeated finalize (a retry) sends nothing more; the CALL_RELEASE job finds nothing to send.
  await act(agent(ws.id), 'call.finalize', { callId })
  expect(await db.transaction(tx => releaseHeldNews(tx, callId))).toBeNull()
  expect(jobsNamed(CALL_NOTIFY)).toHaveLength(1)
})

test('nothing is held when after-call transcription is off, the agent does not ask, or the workspace keeps no recordings', async () => {
  let callId = await liveCall()
  expect((await act(agent(ws.id), 'call.finish', { callId, awaitTranscript: true })).body.data).toEqual({
    held: false,
    named: false,
  })
  expect(jobsNamed(CALL_NOTIFY)).toHaveLength(1)
  expect((await getCall(callId))!.awaiting_transcript_until).toBeNull()

  await transcriptionOn()
  callId = await liveCall()
  expect((await act(agent(ws.id), 'call.finish', { callId })).body.data).toEqual({ held: false, named: false })
  expect(jobsNamed(CALL_NOTIFY)).toHaveLength(1)
  // Not held: the recording is transcribed by the job, as before.
  await act(agent(ws.id), 'call.setRecording', { callId, store: 'file' })
  expect(jobsNamed(CALL_TRANSCRIBE)).toHaveLength(1)
})

test('the agent never finalizes: the CALL_RELEASE job sends the news with the live summary', async () => {
  await transcriptionOn()
  const callId = await liveCall()
  await act(agent(ws.id), 'call.finish', { callId, ...first, awaitTranscript: true })
  const released = await db.transaction(tx => releaseHeldNews(tx, callId))
  expect(released?.title).toBe('Call in Korean')
  expect(jobsNamed(CALL_NOTIFY)).toHaveLength(1)
  // A late finalize changes nothing: the call keeps the summary its email went out with, and no second email.
  expect((await act(agent(ws.id), 'call.finalize', { callId, title: 'Water heater leak' })).status).toBe(200)
  expect((await getCall(callId))!.title).toBe('Call in Korean')
  expect(jobsNamed(CALL_NOTIFY)).toHaveLength(1)
})

test('call.finalize: only for a finished call; a call not held keeps its summary', async () => {
  const callId = await liveCall()
  expect((await act(agent(ws.id), 'call.finalize', { callId, title: 'x' })).status).toBe(409)
  await act(agent(ws.id), 'call.finish', { callId, ...first })
  await act(agent(ws.id), 'call.finalize', { callId, title: 'x' })
  expect((await getCall(callId))!.title).toBe('Call in Korean')
})

test('call.finalize: a title or summary the team changed while held stays', async () => {
  await transcriptionOn()
  const callId = await liveCall()
  await act(agent(ws.id), 'call.finish', { callId, ...first, awaitTranscript: true })
  await db.update(calls).set({ title: 'Korean speaker, call back' }).where(eq(calls.id, callId))
  await act(agent(ws.id), 'call.finalize', {
    callId,
    title: 'Water heater leak',
    summary: 'The water heater leaks.',
    previous: { title: first.title, summary: first.summary },
  })
  const call = (await getCall(callId))!
  expect(call.title).toBe('Korean speaker, call back')
  expect(call.summary).toBe('The water heater leaks.')
  expect(jobsNamed(CALL_NOTIFY)).toHaveLength(1)
})

async function heldWithRecording() {
  const callId = await liveCall()
  await act(agent(ws.id), 'call.finish', { callId, awaitTranscript: true })
  const key = `${ws.id}/${callId}.ogg`
  await mkdir(dirname(join(dir, key)), { recursive: true })
  await writeFile(join(dir, key), Uint8Array.from([1, 2, 3, 4]))
  vi.stubEnv('RECORDINGS_DIR', dir)
  await act(agent(ws.id), 'call.setRecording', { callId, store: 'file' })
  return callId
}

test('call.correctTranscript corrects a held call now, once, and returns its lines; a failure queues the job', async () => {
  await transcriptionOn()
  let callId = await heldWithRecording()

  const realFetch = globalThis.fetch
  vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) =>
    String(url).startsWith('https://api.openai.com/') ? Response.json({ text: HEARD }) : realFetch(url, init),
  )
  const corrected = await act(agent(ws.id), 'call.correctTranscript', { callId })
  expect(corrected.body.data.status).toBe('updated')
  expect(corrected.body.data.lines).toContainEqual({
    speaker: 'caller',
    text: 'My water heater is leaking. Can you send someone?',
  })

  // Once: a second request (a retry) uploads nothing again.
  expect((await act(agent(ws.id), 'call.correctTranscript', { callId })).body.data).toEqual({ status: 'skipped' })
  // The CALL_RELEASE job queues no second transcription of a call whose transcription started.
  await db.transaction(tx => releaseHeldNews(tx, callId))
  expect((await getCall(callId))!.transcript_requested_at).not.toBeNull()

  callId = await heldWithRecording()
  vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) =>
    String(url).startsWith('https://api.openai.com/') ? new Response('busy', { status: 503 }) : realFetch(url, init),
  )
  sent.mockClear()
  expect((await act(agent(ws.id), 'call.correctTranscript', { callId })).body.data).toEqual({ status: 'failed' })
  expect(jobsNamed(CALL_TRANSCRIBE)).toHaveLength(1)

  // Not held: nothing to do.
  callId = await heldWithRecording()
  await act(agent(ws.id), 'call.finalize', { callId })
  expect((await act(agent(ws.id), 'call.correctTranscript', { callId })).body.data).toEqual({ status: 'skipped' })
  vi.unstubAllEnvs()
})

test('call.finalize: an urgency only the first summary set may change while held; a name only finish wrote is corrected', async () => {
  await transcriptionOn()
  let callId = await liveCall()
  const finished = await act(agent(ws.id), 'call.finish', {
    callId,
    ...first,
    urgency: 'urgent',
    callerName: 'Jon Smith',
    awaitTranscript: true,
  })
  expect(finished.body.data).toEqual({ held: true, named: true })
  await act(agent(ws.id), 'call.finalize', {
    callId,
    urgency: 'normal',
    callerName: 'Joan Smith',
    previous: { actionItems: [], urgency: 'urgent', callerName: 'Jon Smith' },
  })
  const call = (await getCall(callId))!
  expect(call.urgency).toBe('normal')
  const [contact] = await db.select().from(contacts).where(eq(contacts.id, call.contact_id!))
  expect(contact!.name).toBe('Joan Smith')

  // Flagged urgent outside the first summary (the team, a tool): it stays.
  callId = await liveCall()
  await act(agent(ws.id), 'call.finish', { callId, ...first, urgency: 'normal', awaitTranscript: true })
  await db.update(calls).set({ urgency: 'urgent' }).where(eq(calls.id, callId))
  await act(agent(ws.id), 'call.finalize', {
    callId,
    urgency: 'normal',
    previous: { actionItems: [], urgency: 'normal' },
  })
  expect((await getCall(callId))!.urgency).toBe('urgent')
})

test('a provider that refuses the hints hears the call without them', async () => {
  let attempt = 0
  const transcriber: Transcriber & { hints: unknown[] } = {
    model: 'gpt-transcribe',
    maxBytes: 1000,
    hints: [],
    async transcribe(_audio, _file, given) {
      transcriber.hints.push(given)
      if (attempt++ === 0) throw new TranscriberError(400, 'Unknown parameter: keywords')
      return { text: HEARD }
    },
  }
  expect((await transcribeCallAgain(db, ws.call.id, transcriber, storeFor)).status).toBe('updated')
  expect(transcriber.hints[1]).toEqual({ terms: [], language: null })
})

test('the model is told the names the call may contain and its language; a name the caller gave is not one', async () => {
  await db
    .update(assistants)
    .set({ name: 'Maya', languages: { main: 'en', mode: 'english', allowed: [] } })
    .where(eq(assistants.id, ws.assistant.id))
  await db.update(calls).set({ assistant_id: ws.assistant.id }).where(eq(calls.id, ws.call.id))
  await db.insert(appointment_types).values([
    { id: `at_${ws.id}_1`, workspace_id: ws.id, name: 'Water heater repair', duration_min: 60 },
    { id: `at_${ws.id}_2`, workspace_id: ws.id, name: 'Old visit', duration_min: 60, enabled: false },
  ])
  // "Known Caller" without a source counts as the caller's.
  expect(await transcriptHints(db, ws.call.id)).toEqual({
    terms: ['Brightwater Plumbing & Heating', 'Maya', 'Water heater repair'],
    language: 'en',
  })
  await db
    .update(contacts)
    .set({ name: 'Dana Reyes', name_source: 'member', company: 'Reyes Bakery' })
    .where(eq(contacts.id, ws.contact.id))
  await db
    .update(assistants)
    .set({ languages: { main: 'de', mode: 'allowed', allowed: ['en'] } })
    .where(eq(assistants.id, ws.assistant.id))
  expect(await transcriptHints(db, ws.call.id)).toEqual({
    terms: ['Brightwater Plumbing & Heating', 'Maya', 'Dana Reyes', 'Reyes Bakery', 'Water heater repair'],
    language: null,
  })

  const transcriber = fakeTranscriber(HEARD)
  await transcribeCallAgain(db, ws.call.id, transcriber, storeFor)
  expect(transcriber.hints[0]).toEqual(await transcriptHints(db, ws.call.id))
})
