// Recording retention: a workspace setting (90 days by default, null keeps recordings) and the daily
// cleanup that deletes older recordings from the store and clears the call's key.
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { recordingKey } from '@linedesk/actions'
import { calls, transcript_segments, workspace_settings } from '@linedesk/db'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { db } from '../src/db.ts'
import { deleteExpiredRecordings } from '../src/recording-retention.ts'
import { createFileRecordingStore } from '../src/recording-store.ts'
import { act, addMember, createWorkspace, getCall, randomNumber, type Workspace } from './helpers.ts'

const DAY_MS = 86_400_000
const NOW = '2026-11-10T12:00:00.000Z'
const daysAgo = (days: number) => new Date(Date.parse(NOW) - days * DAY_MS).toISOString()

let dir: string
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'linedesk-retention-'))
})
afterAll(() => rm(dir, { recursive: true, force: true }))

/** A finished call `age` days ago with a recording file in the store. */
async function recordedCall(ws: Workspace, age: number) {
  const id = `call_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`
  const key = recordingKey(ws.id, id)
  await db.insert(calls).values({
    id,
    workspace_id: ws.id,
    from_number: randomNumber(),
    to_number: ws.number,
    status: 'completed',
    started_at: daysAgo(age),
    ended_at: daysAgo(age),
    recording_key: key,
  })
  await mkdir(dirname(join(dir, key)), { recursive: true })
  await writeFile(join(dir, key), 'audio')
  return { id, key }
}
const fileExists = async (key: string) =>
  (await readdir(dirname(join(dir, key))).catch((): string[] => [])).includes(key.split('/')[1]!)

describe('workspace.getSettings and workspace.updateSettings', () => {
  test('a new workspace keeps recordings 90 days; owners change it, members only read it', async () => {
    const ws = await createWorkspace('Retention Settings Plumbing')
    expect((await act(ws.owner, 'workspace.getSettings', {})).body.data).toMatchObject({ recordingRetentionDays: 90 })
    expect((await act(ws.owner, 'workspace.updateSettings', { recordingRetentionDays: 30 })).status).toBe(200)
    expect((await act(ws.owner, 'workspace.getSettings', {})).body.data).toMatchObject({ recordingRetentionDays: 30 })
    const member = await addMember(ws.id, 'member')
    expect((await act(member, 'workspace.getSettings', {})).body.data).toMatchObject({ recordingRetentionDays: 30 })
    expect((await act(member, 'workspace.updateSettings', { recordingRetentionDays: null })).status).toBe(403)
    expect((await act(ws.owner, 'workspace.updateSettings', { recordingRetentionDays: 45 })).status).toBe(422)
  })

  test('one workspace never changes another', async () => {
    const ws = await createWorkspace('Retention Mine')
    const other = await createWorkspace('Retention Theirs')
    await act(ws.owner, 'workspace.updateSettings', { recordingRetentionDays: null })
    expect((await act(other.owner, 'workspace.getSettings', {})).body.data).toMatchObject({
      recordingRetentionDays: 90,
    })
  })
})

describe('deleteExpiredRecordings', () => {
  test('deletes recordings past each workspace retention and keeps the rest', async () => {
    const short = await createWorkspace('Thirty Days Plumbing')
    await act(short.owner, 'workspace.updateSettings', { recordingRetentionDays: 30 })
    const forever = await createWorkspace('Keep Forever Plumbing')
    await act(forever.owner, 'workspace.updateSettings', { recordingRetentionDays: null })
    const legacy = await createWorkspace('No Settings Row Plumbing')
    await db.delete(workspace_settings).where(eq(workspace_settings.workspace_id, legacy.id))

    const old = await recordedCall(short, 40)
    const recent = await recordedCall(short, 10)
    const kept = await recordedCall(forever, 400)
    const legacyOld = await recordedCall(legacy, 100)
    const legacyRecent = await recordedCall(legacy, 60)

    const store = createFileRecordingStore(dir)
    // Other test files leave recordings too; run until nothing of ours is left to delete.
    for (let i = 0; i < 20 && (await getCall(old.id))?.recording_key; i++)
      await deleteExpiredRecordings(db, () => store, NOW)

    expect((await getCall(old.id))?.recording_key).toBeNull()
    expect(await fileExists(old.key)).toBe(false)
    expect((await getCall(legacyOld.id))?.recording_key).toBeNull()
    expect(await fileExists(legacyOld.key)).toBe(false)
    for (const call of [recent, kept, legacyRecent]) {
      expect((await getCall(call.id))?.recording_key).toBe(call.key)
      expect(await fileExists(call.key)).toBe(true)
    }
  })

  test('only the audio goes: the call, its summary and its transcript are never deleted', async () => {
    const ws = await createWorkspace('Transcripts Stay Plumbing')
    await act(ws.owner, 'workspace.updateSettings', { recordingRetentionDays: 30 })
    const old = await recordedCall(ws, 400)
    await db.update(calls).set({ summary: 'Leak under the kitchen sink.' }).where(eq(calls.id, old.id))
    await db.insert(transcript_segments).values([
      {
        id: crypto.randomUUID(),
        workspace_id: ws.id,
        call_id: old.id,
        speaker: 'caller',
        text: 'My kitchen sink is leaking.',
        at_ms: 1000,
      },
      {
        id: crypto.randomUUID(),
        workspace_id: ws.id,
        call_id: old.id,
        speaker: 'agent',
        text: 'I can book a plumber for you.',
        at_ms: 3000,
      },
    ])
    const store = createFileRecordingStore(dir)
    for (let i = 0; i < 20 && (await getCall(old.id))?.recording_key; i++)
      await deleteExpiredRecordings(db, () => store, NOW)

    expect(await getCall(old.id)).toMatchObject({ recording_key: null, summary: 'Leak under the kitchen sink.' })
    const segments = await db.select().from(transcript_segments).where(eq(transcript_segments.call_id, old.id))
    expect(segments.map(s => s.text)).toEqual(['My kitchen sink is leaking.', 'I can book a plumber for you.'])
  })

  test('a recording whose file cannot be deleted keeps its key and is retried next time', async () => {
    const ws = await createWorkspace('Failing Store Plumbing')
    await act(ws.owner, 'workspace.updateSettings', { recordingRetentionDays: 30 })
    const call = await recordedCall(ws, 40)
    const broken = {
      ...createFileRecordingStore(dir),
      delete: async () => {
        throw new Error('disk is read-only')
      },
    }
    const result = await deleteExpiredRecordings(db, () => broken, NOW)
    expect(result.failed).toBeGreaterThan(0)
    expect((await getCall(call.id))?.recording_key).toBe(call.key)
  })
})
