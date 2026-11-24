// The recording notice: a setting of each assistant (on by default, LIN-710) that it says right after the greeting.
// The agent gets it from call.start, and from the greetings it stores before the first call.
import { DEFAULT_RECORDING_NOTICE } from '@linedesk/actions'
import { assistants } from '@linedesk/db'
import { eq } from 'drizzle-orm'
import { describe, expect, test } from 'vitest'
import { db } from '../src/db.ts'
import { greetingsToStore } from '../src/greetings-to-store.ts'
import { act, addMember, agent, createWorkspace, randomNumber } from './helpers.ts'

const noticeAt = async (to: string) =>
  (await act(agent(), 'call.start', { from: randomNumber(), to })).body.data.recordingNotice

describe('recording notice', () => {
  test('on by default: call.start brings the default notice', async () => {
    const ws = await createWorkspace('Notice Default Plumbing')
    const [row] = await db.select().from(assistants).where(eq(assistants.id, ws.assistant.id))
    expect(row).toMatchObject({ recording_notice_on: true, recording_notice: null })
    expect(await noticeAt(ws.number)).toBe(DEFAULT_RECORDING_NOTICE)
  })

  test('off: call.start brings no notice; on again, the default or the owner’s own sentence', async () => {
    const ws = await createWorkspace('Notice Toggle Plumbing')
    const update = (input: Record<string, unknown>) =>
      act(ws.owner, 'assistant.update', { assistantId: ws.assistant.id, ...input })
    expect((await update({ recording_notice_on: false })).status).toBe(200)
    expect(await noticeAt(ws.number)).toBeNull()
    expect((await update({ recording_notice_on: true })).status).toBe(200)
    expect(await noticeAt(ws.number)).toBe(DEFAULT_RECORDING_NOTICE)
    const own = 'This call is recorded for quality.'
    expect((await update({ recording_notice: `  ${own} ` })).status).toBe(200)
    expect(await noticeAt(ws.number)).toBe(own)
    // null: the default again.
    expect((await update({ recording_notice: null })).status).toBe(200)
    expect(await noticeAt(ws.number)).toBe(DEFAULT_RECORDING_NOTICE)
  })

  test('each assistant has its own: a second assistant keeps its notice when the first turns it off', async () => {
    const ws = await createWorkspace('Notice Two Assistants Plumbing')
    const second = (await act(ws.owner, 'assistant.create', {})).body.data.assistantId as string
    await act(ws.owner, 'assistant.update', { assistantId: ws.assistant.id, recording_notice_on: false })
    await act(ws.owner, 'assistant.update', { assistantId: second, recording_notice: 'Second line is recorded.' })
    const rows = await db.select().from(assistants).where(eq(assistants.workspace_id, ws.id))
    expect(rows.find(r => r.id === ws.assistant.id)).toMatchObject({ recording_notice_on: false })
    expect(rows.find(r => r.id === second)).toMatchObject({
      recording_notice_on: true,
      recording_notice: 'Second line is recorded.',
    })
    expect(await noticeAt(ws.number)).toBeNull()
    // The greetings stored before the first call carry the notice of the assistant that answers.
    const stored = (await db.transaction(tx => greetingsToStore(tx, new Date().toISOString()))).find(
      g => (g.assistant as { id: string }).id === ws.assistant.id,
    )
    expect(stored?.recordingNotice).toBeNull()
    // greetingsToStore walks every number in the shared test database (several queries each), so on CI's runner, with
    // the other files' workspaces in it, this one test can pass the default 5 s.
  }, 30_000)

  test('restoring an earlier version keeps the notice as it is', async () => {
    const ws = await createWorkspace('Notice Restore Plumbing')
    const assistantId = ws.assistant.id
    await act(ws.owner, 'assistant.update', { assistantId, greeting: 'Hi, first version.' })
    await act(ws.owner, 'assistant.update', { assistantId, recording_notice: 'Own notice.' })
    const versions = (await act(ws.owner, 'assistant.versions', { assistantId })).body.data.versions as {
      number: number
    }[]
    const first = versions.at(-1)!.number
    expect((await act(ws.owner, 'assistant.restoreVersion', { assistantId, number: first })).status).toBe(200)
    expect(await noticeAt(ws.number)).toBe('Own notice.')
  })

  test('owners change it, members cannot; empty or very long sentences are refused', async () => {
    const ws = await createWorkspace('Notice Rules Plumbing')
    const member = await addMember(ws.id, 'member')
    const id = ws.assistant.id
    expect((await act(member, 'assistant.update', { assistantId: id, recording_notice_on: false })).status).toBe(403)
    expect((await act(ws.owner, 'assistant.update', { assistantId: id, recording_notice: '   ' })).status).toBe(422)
    expect(
      (await act(ws.owner, 'assistant.update', { assistantId: id, recording_notice: 'x'.repeat(201) })).status,
    ).toBe(422)
    expect(await noticeAt(ws.number)).toBe(DEFAULT_RECORDING_NOTICE)
  })
})
