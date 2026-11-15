// Live calls whose agent went away are ended by the API after a quiet period, and filed honestly.
import { calls, transcript_segments } from '@linedesk/db'
import { eq } from 'drizzle-orm'
import { expect, test, vi } from 'vitest'
import { db } from '../src/db.ts'
import { listLivekitRooms } from '../src/livekit-status.ts'
import { cutOffResult, finishStaleCalls } from '../src/stale-calls.ts'
import { createWorkspace, getCall, randomNumber } from './helpers.ts'

const uid = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`

// In the past, so live calls other test files open right now are never in the sweep's window.
const now = new Date('2020-01-01T12:00:00.000Z')
/** No LiveKit in these tests: rooms are deleted through this. */
const noRoom = async () => true
/** LiveKit cannot be asked: the sweep falls back to quiet time alone. */
const noLivekit = async () => null
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000).toISOString()

async function liveCall(
  workspaceId: string,
  startedMinAgo: number,
  lines: [speaker: 'agent' | 'caller', atMin: number][],
  room: string | null = null,
  source: 'phone' | 'test' | 'simulated' = 'phone',
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
      source,
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
  const ended = await finishStaleCalls(db, { now, staleAfterMin: 10, listRooms: noLivekit, endRoom: noRoom })
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
  const ended = await finishStaleCalls(db, { now, staleAfterMin: 10, listRooms: noLivekit, endRoom: noRoom })
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
  await finishStaleCalls(db, { now, staleAfterMin: 10, listRooms: noLivekit, endRoom: noRoom })
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
    const ended = await finishStaleCalls(db, { now, staleAfterMin: 10, listRooms: noLivekit, endRoom: async room => {
      if (room === unreachableRoom) throw new Error('LiveKit is down')
      deleted.push(room)
      return true
    } })
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
  const ended = await finishStaleCalls(db, { now, staleAfterMin: 10, listRooms: noLivekit, endRoom })
  expect(ended).toContain(over)
  expect(ended).not.toContain(talking)
  expect(await getCall(talking)).toMatchObject({ status: 'live' })
  expect(removed).toEqual([(await getCall(over))!.room])
})

test('a call whose LiveKit room is gone ends after a minute of quiet; one whose room is open never ends', async () => {
  const ws = await createWorkspace('Brightwater Plumbing & Heating')
  const room = () => `test-${uid('room')}`
  // A test call from the browser whose agent lost the API: the room is gone, the last line 2 minutes ago.
  const gone = await liveCall(ws.id, 5, [['agent', 0], ['caller', 3]], room(), 'test')
  // Room gone too, but the last line only 30 seconds ago: not yet.
  const justQuiet = await liveCall(ws.id, 5, [['agent', 0], ['caller', 4.5]], room(), 'test')
  // Quiet for 30 minutes, but LiveKit still has the room: never ended, and the room is left alone.
  const open = await liveCall(ws.id, 40, [['caller', 1]], room(), 'phone')
  const openRoom = (await getCall(open))!.room!
  const deleted: string[] = []
  const ended = await finishStaleCalls(db, {
    now,
    staleAfterMin: 10,
    listRooms: async () => new Map([[openRoom, 1], ['call-somebody-else', 2]]),
    endRoom: async r => {
      deleted.push(r)
      return true
    },
  })
  expect(ended).toContain(gone)
  expect(ended).not.toContain(justQuiet)
  expect(ended).not.toContain(open)
  expect(await getCall(gone)).toMatchObject({ status: 'completed', outcome: 'callback', duration_sec: 180 })
  expect(await getCall(open)).toMatchObject({ status: 'live' })
  expect(deleted).toEqual([]) // a room LiveKit no longer has needs no delete; an open one is never deleted
})

test('a call whose agent died ends after a minute of quiet: LiveKit keeps its room open with nobody in it, and the room is deleted (LIN-277)', async () => {
  const ws = await createWorkspace('Brightwater Plumbing & Heating')
  const room = () => `call-${uid('room')}`
  // The agent process was killed 3 minutes ago: its room is still listed, with no participant.
  const deadAgent = await liveCall(ws.id, 5, [['agent', 0], ['caller', 2]], room(), 'phone')
  // Empty too, but the last line only 30 seconds ago: not yet.
  const justQuiet = await liveCall(ws.id, 5, [['caller', 4.5]], room(), 'test')
  // Somebody is still in the room (on hold, thinking): live, however quiet.
  const occupied = await liveCall(ws.id, 40, [['caller', 1]], room(), 'phone')
  const [deadRoom, quietRoom, occupiedRoom] = await Promise.all([deadAgent, justQuiet, occupied].map(async id => (await getCall(id))!.room!))
  const deleted: string[] = []
  const ended = await finishStaleCalls(db, {
    now,
    staleAfterMin: 10,
    listRooms: async () => new Map([[deadRoom!, 0], [quietRoom!, 0], [occupiedRoom!, 1]]),
    endRoom: async r => {
      deleted.push(r)
      return true
    },
  })
  expect(ended).toContain(deadAgent)
  expect(ended).not.toContain(justQuiet)
  expect(ended).not.toContain(occupied)
  expect(await getCall(deadAgent)).toMatchObject({ status: 'completed', outcome: 'callback', duration_sec: 120 })
  expect(deleted).toEqual([deadRoom])
})

test('without an answer from LiveKit, a test call ends after 2 quiet minutes and a phone call after the full limit', async () => {
  const ws = await createWorkspace('Brightwater Plumbing & Heating')
  const testCall = await liveCall(ws.id, 5, [['caller', 2]], `test-${uid('room')}`, 'test')
  const phoneCall = await liveCall(ws.id, 5, [['caller', 2]], `call-${uid('room')}`, 'phone')
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    const ended = await finishStaleCalls(db, {
      now,
      staleAfterMin: 10,
      listRooms: async () => {
        throw new Error('LiveKit is down')
      },
      endRoom: noRoom,
    })
    expect(ended).toContain(testCall)
    expect(ended).not.toContain(phoneCall)
  } finally {
    warn.mockRestore()
  }
})

test('a simulated call has no LiveKit room: only its quiet time counts', async () => {
  const ws = await createWorkspace('Brightwater Plumbing & Heating')
  const simulated = await liveCall(ws.id, 5, [['caller', 3]], uid('call'), 'simulated')
  const ended = await finishStaleCalls(db, { now, staleAfterMin: 10, listRooms: async () => new Map(), endRoom: noRoom })
  expect(ended).not.toContain(simulated)
})

test('a call that ran a while without any caller line says its transcript was lost, not that the caller was silent', async () => {
  const ws = await createWorkspace('Brightwater Plumbing & Heating')
  // The caller's lines never reached the API; the assistant's last line came 2 minutes in.
  const lost = await liveCall(ws.id, 30, [['agent', 0], ['agent', 2]])
  await finishStaleCalls(db, { now, staleAfterMin: 10, listRooms: noLivekit, endRoom: noRoom })
  expect(await getCall(lost)).toMatchObject({
    status: 'completed',
    outcome: 'hangup',
    summary: 'The call ended before it was wrapped up, and its transcript was not saved.',
    action_items: [],
  })
  expect(cutOffResult(0, 5_000).summary).toBe('The call ended before the caller said anything.')
  expect(cutOffResult(0, 25_000)).toMatchObject({ outcome: 'hangup', action_items: [] })
  expect(cutOffResult(1, 0)).toMatchObject({ outcome: 'callback', action_items: [{ text: 'Call back' }] })
})

test('listLivekitRooms: the open rooms with their participant count, or null when LiveKit is not set up or does not answer', async () => {
  const env = { LIVEKIT_URL: 'wss://livekit.example.test', LIVEKIT_API_KEY: 'APImadeup', LIVEKIT_API_SECRET: 'made-up-secret-0123456789' }
  const answer = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch
  const rooms = [{ name: 'call-a', num_participants: 2 }, { name: 'test-b', num_participants: 0 }, { name: 'call-c' }]
  // A room without a count counts as occupied: the sweep never ends a call on a guess.
  expect(await listLivekitRooms(env, answer(200, { rooms }))).toEqual(new Map([['call-a', 2], ['test-b', 0], ['call-c', 1]]))
  expect(await listLivekitRooms(env, answer(200, {}))).toEqual(new Map())
  expect(await listLivekitRooms(env, answer(401, {}))).toBeNull()
  expect(await listLivekitRooms({}, answer(200, { rooms: [] }))).toBeNull()
  const down = (async () => {
    throw new TypeError('fetch failed')
  }) as unknown as typeof fetch
  expect(await listLivekitRooms(env, down)).toBeNull()
})
