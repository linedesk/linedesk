// Live calls whose agent went away are ended by the API after a quiet period, and filed honestly.
import { calls, transcript_segments } from '@linedesk/db'
import { eq } from 'drizzle-orm'
import { expect, test, vi } from 'vitest'
import { db } from '../src/db.ts'
import { finishStaleCalls } from '../src/stale-calls.ts'
import { createWorkspace, getCall, randomNumber } from './helpers.ts'

const uid = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`

// In the past, so live calls other test files open right now are never in the sweep's window.
const now = new Date('2020-01-01T12:00:00.000Z')
/** No LiveKit in these tests: rooms are deleted through this. */
const noRoom = async () => true
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000).toISOString()

async function liveCall(
  workspaceId: string,
  startedMinAgo: number,
  lines: [speaker: 'agent' | 'caller', atMin: number][],
  room: string | null = null,
) {
  const id = uid('call')
  await db
    .insert(calls)
    .values({
      id,
      workspace_id: workspaceId,
      from_number: randomNumber(),
      to_number: randomNumber(),
      started_at: minutesAgo(startedMinAgo),
      status: 'live',
      room,
    })
  for (const [speaker, atMin] of lines) {
    await db
      .insert(transcript_segments)
      .values({ id: uid('seg'), workspace_id: workspaceId, call_id: id, speaker, text: 'Hello', at_ms: atMin * 60_000 })
  }
  return id
}

test('a live call quiet for longer than the limit ends; a caller who spoke gets a callback', async () => {
  const ws = await createWorkspace('Brightwater Plumbing & Heating')
  const spoke = await liveCall(ws.id, 30, [
    ['agent', 0],
    ['caller', 1],
  ])
  const silent = await liveCall(ws.id, 30, [['agent', 0]])
  const ended = await finishStaleCalls(db, now, 10, noRoom)
  expect(ended).toEqual(expect.arrayContaining([spoke, silent]))

  expect(await getCall(spoke)).toMatchObject({
    status: 'completed',
    outcome: 'callback',
    title: 'Call cut off',
    duration_sec: 60,
    action_items: [{ text: 'Call back' }],
  })
  expect(await getCall(silent)).toMatchObject({ status: 'completed', outcome: 'hangup', action_items: [] })
})

test('a call that is still talking, or just started, stays live', async () => {
  const ws = await createWorkspace('Brightwater Plumbing & Heating')
  const talking = await liveCall(ws.id, 30, [
    ['agent', 0],
    ['caller', 25],
  ]) // last line 5 minutes ago
  const fresh = await liveCall(ws.id, 3, [])
  const ended = await finishStaleCalls(db, now, 10, noRoom)
  expect(ended).not.toContain(talking)
  expect(ended).not.toContain(fresh)
  expect((await getCall(talking))?.status).toBe('live')
})

test('what the call already had is kept', async () => {
  const ws = await createWorkspace('Brightwater Plumbing & Heating')
  const id = await liveCall(ws.id, 30, [['caller', 0]])
  await db
    .update(calls)
    .set({ title: 'Leak in the basement', action_items: [{ text: 'Bring a pump' }] })
    .where(eq(calls.id, id))
  await finishStaleCalls(db, now, 10, noRoom)
  expect(await getCall(id)).toMatchObject({ title: 'Leak in the basement', action_items: [{ text: 'Bring a pump' }] })
})

test("an ended call's LiveKit room is deleted, so a line still open is hung up; a live call's room is not; a failure does not stop the sweep", async () => {
  const ws = await createWorkspace('Brightwater Plumbing & Heating')
  const stale = await liveCall(ws.id, 30, [['caller', 0]], `call-${uid('room')}`)
  const unreachable = await liveCall(ws.id, 30, [['caller', 0]], `call-${uid('room')}`)
  const talking = await liveCall(ws.id, 30, [['caller', 28]], `call-${uid('room')}`)
  const [staleRoom, unreachableRoom, talkingRoom] = await Promise.all([stale, unreachable, talking].map(async id => (await getCall(id))!.room!))
  const deleted: string[] = []
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    const ended = await finishStaleCalls(db, now, 10, async room => {
      if (room === unreachableRoom) throw new Error('LiveKit is down')
      deleted.push(room)
      return true
    })
    expect(ended).toEqual(expect.arrayContaining([stale, unreachable]))
    expect(deleted).toContain(staleRoom)
    expect(deleted).not.toContain(talkingRoom)
    expect(await getCall(unreachable)).toMatchObject({ status: 'completed' })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(unreachableRoom!))
  } finally {
    warn.mockRestore()
  }
})

test('a call put through to a person is not cut off while it may still run (up to 2 hours), and is after that', async () => {
  const ws = await createWorkspace('Brightwater Plumbing & Heating')
  const removed: string[] = []
  const endRoom = async (room: string) => {
    removed.push(room)
    return true
  }
  // The transcript stops at the transfer: 40 minutes without a line, and still a live conversation.
  const talking = await liveCall(ws.id, 45, [['caller', 1], ['agent', 5]], uid('room'))
  const over = await liveCall(ws.id, 130, [['caller', 1], ['agent', 5]], uid('room'))
  await db.update(calls).set({ transfer_to: '+15035550199', transfer_result: 'connected' }).where(eq(calls.workspace_id, ws.id))
  const ended = await finishStaleCalls(db, now, 10, endRoom)
  expect(ended).toContain(over)
  expect(ended).not.toContain(talking)
  expect(await getCall(talking)).toMatchObject({ status: 'live' })
  expect(removed).toEqual([(await getCall(over))!.room])
})
