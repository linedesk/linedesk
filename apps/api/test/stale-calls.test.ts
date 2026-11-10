// Live calls whose agent went away are ended by the API after a quiet period, and filed honestly.
import { calls, transcript_segments } from '@callfront/db'
import { eq } from 'drizzle-orm'
import { expect, test } from 'vitest'
import { db } from '../src/db.ts'
import { finishStaleCalls } from '../src/stale-calls.ts'
import { createWorkspace, getCall, randomNumber } from './helpers.ts'

const uid = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`

// In the past, so live calls other test files open right now are never in the sweep's window.
const now = new Date('2020-01-01T12:00:00.000Z')
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000).toISOString()

async function liveCall(
  workspaceId: string,
  startedMinAgo: number,
  lines: [speaker: 'agent' | 'caller', atMin: number][],
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
  const ended = await finishStaleCalls(db, now, 10)
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
  const ended = await finishStaleCalls(db, now, 10)
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
  await finishStaleCalls(db, now, 10)
  expect(await getCall(id)).toMatchObject({ title: 'Leak in the basement', action_items: [{ text: 'Bring a pump' }] })
})
