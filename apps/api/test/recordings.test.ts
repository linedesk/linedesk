// Recordings: the agent reports a call's recording, the server derives where it is, and only
// members of the call's workspace get the audio through GET /v1/calls/:id/recording.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { calls } from '@linedesk/db'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { app } from '../src/app.ts'
import { db } from '../src/db.ts'
import { linkOrphanRecordings } from '../src/orphan-recordings.ts'
import { createFileRecordingStore } from '../src/recording-store.ts'
import { act, agent, anonymous, createWorkspace, getCall, randomNumber, type Caller, type Workspace } from './helpers.ts'

const audio = Uint8Array.from({ length: 1000 }, (_, i) => i % 256)
let dir: string
let ws: Workspace
let other: Workspace
let key: string

const recording = (who: Caller, callId: string, range?: string) =>
  app.request(`/v1/calls/${callId}/recording`, { headers: { ...who.headers, ...(range ? { range } : {}) } })
const setKey = (recording_key: string | null) => db.update(calls).set({ recording_key }).where(eq(calls.id, ws.call.id))
async function writeRecording(path: string, body: Uint8Array | string = audio) {
  await mkdir(dirname(join(dir, path)), { recursive: true })
  await writeFile(join(dir, path), body)
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'linedesk-recordings-'))
  process.env.RECORDING_STORE = 'file'
  process.env.RECORDINGS_DIR = dir
  ws = await createWorkspace('Brightwater Plumbing & Heating')
  other = await createWorkspace('Other Business')
  key = `${ws.id}/${ws.call.id}.ogg`
  await writeRecording(key)
})
afterAll(() => rm(dir, { recursive: true, force: true }))

test('a call has no recording until the agent reports it; the key is derived on the server', async () => {
  expect((await recording(ws.owner, ws.call.id)).status).toBe(404)
  expect((await act(agent(other.id), 'call.setRecording', { callId: ws.call.id })).status).toBe(409)
  expect((await act(agent(), 'call.setRecording', { callId: ws.call.id })).status).toBe(409)
  expect((await act(ws.owner, 'call.setRecording', { callId: ws.call.id })).status).toBe(403)

  const sneaky = await act(agent(ws.id), 'call.setRecording', { callId: ws.call.id, recordingKey: `${other.id}/${other.call.id}.ogg`, format: 'ogg' })
  expect(sneaky.status).toBe(200)
  expect(sneaky.body.rows.calls[0].recording_key).toBe(key)
  expect((await getCall(ws.call.id))?.recording_key).toBe(key)
  expect((await act(agent(ws.id), 'call.setRecording', { callId: ws.call.id, format: 'sh' })).status).toBe(422)
})

test('a member of the workspace gets the whole file', async () => {
  const res = await recording(ws.owner, ws.call.id)
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toBe('audio/ogg')
  expect(res.headers.get('content-length')).toBe('1000')
  expect(res.headers.get('accept-ranges')).toBe('bytes')
  expect(res.headers.get('cache-control')).toBe('private, no-store')
  expect(new Uint8Array(await res.arrayBuffer())).toEqual(audio)
})

test('range requests return the asked bytes, so players can seek', async () => {
  const part = await recording(ws.owner, ws.call.id, 'bytes=100-199')
  expect(part.status).toBe(206)
  expect(part.headers.get('content-range')).toBe('bytes 100-199/1000')
  expect(part.headers.get('content-length')).toBe('100')
  expect(new Uint8Array(await part.arrayBuffer())).toEqual(audio.slice(100, 200))

  const tail = await recording(ws.owner, ws.call.id, 'bytes=-10')
  expect(new Uint8Array(await tail.arrayBuffer())).toEqual(audio.slice(990))

  const beyond = await recording(ws.owner, ws.call.id, 'bytes=5000-')
  expect(beyond.status).toBe(416)
  expect(beyond.headers.get('content-range')).toBe('bytes */1000')
})

test('nobody outside the workspace gets it: other workspace, agent token, no session', async () => {
  expect((await recording(other.owner, ws.call.id)).status).toBe(404)
  expect((await recording(agent(ws.id), ws.call.id)).status).toBe(403)
  expect((await recording(anonymous, ws.call.id)).status).toBe(401)
})

test('only the key that belongs to the call is served, whatever the column holds', async () => {
  await writeRecording(`${other.id}/${other.call.id}.ogg`, 'the other workspace')
  await writeRecording('secret.txt', 'outside any workspace')
  try {
    for (const stored of [`${other.id}/${other.call.id}.ogg`, '../secret.txt', '../../../etc/hosts', `${ws.id}/../secret.txt`, join(dir, 'secret.txt'), `${ws.id}/missing.ogg`]) {
      await setKey(stored)
      expect((await recording(ws.owner, ws.call.id)).status).toBe(404)
    }
  } finally {
    await setKey(key)
  }
  expect((await recording(ws.owner, ws.call.id)).status).toBe(200)
})

test('the sweep links a recording file that was never reported, and nothing else', async () => {
  const start = () => act(agent(), 'call.start', { from: randomNumber(), to: other.number })
  const reported = (await start()).body.data.callId as string
  const lost = (await start()).body.data.callId as string
  const live = (await start()).body.data.callId as string
  for (const id of [reported, lost]) expect((await act(agent(other.id), 'call.finish', { callId: id })).status).toBe(200)
  await writeRecording(`${other.id}/${lost}.ogg`)
  await writeRecording(`${other.id}/${live}.ogg`) // still being written: the call is live

  const { body } = await start()
  expect(body.rows.calls.map((c: { id: string }) => c.id)).toEqual([body.data.callId]) // not on the call's path
  expect((await getCall(lost))?.recording_key).toBeNull()
  const linked = await linkOrphanRecordings(db, { name: 'file', store: createFileRecordingStore(dir) })
  expect(linked).toContain(lost)
  expect(linked).not.toContain(reported)
  expect((await getCall(lost))?.recording_key).toBe(`${other.id}/${lost}.ogg`)
  expect((await getCall(lost))?.recording_store).toBe('file')
  expect((await getCall(reported))?.recording_key).toBeNull()
  expect((await getCall(live))?.recording_key).toBeNull()
  expect((await recording(other.owner, lost)).status).toBe(200)
})

test('with an S3 store the route redirects to a short-lived signed link', async () => {
  Object.assign(process.env, { RECORDING_STORE: 's3', S3_ENDPOINT: 'https://s3.test', S3_BUCKET: 'recordings', S3_ACCESS_KEY_ID: 'k', S3_SECRET_ACCESS_KEY: 's' })
  try {
    const res = await recording(ws.owner, ws.call.id)
    expect(res.status).toBe(302)
    const location = new URL(res.headers.get('location')!)
    // S3 settings stored by admin.test (same database, running alongside) win over these env values: only the key is fixed.
    expect(location.pathname.endsWith(`/${key}`)).toBe(true)
    expect(location.searchParams.get('X-Amz-Expires')).toBe('300')
    expect((await recording(other.owner, ws.call.id)).status).toBe(404)
  } finally {
    process.env.RECORDING_STORE = 'file'
  }
})

test('a recording store that is not configured is a rejection, and does not break call.start', async () => {
  const saved = { ...process.env }
  // A store named only by env (S3 settings may be stored by admin.test in the same database meanwhile).
  process.env.RECORDING_STORE = 'minio'
  try {
    const res = await recording(ws.owner, ws.call.id)
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ ok: false, error: 'recording storage is not set up: unknown RECORDING_STORE "minio" (use file or s3)' })
    expect((await act(agent(), 'call.start', { from: randomNumber(), to: other.number })).status).toBe(200)
  } finally {
    Object.assign(process.env, saved)
  }
})
