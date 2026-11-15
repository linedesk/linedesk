// The recording notice: a workspace setting (on by default) the assistant says right after the
// greeting. The agent gets it from call.start.
import { DEFAULT_RECORDING_NOTICE } from '@linedesk/actions'
import { workspace_settings } from '@linedesk/db'
import { eq } from 'drizzle-orm'
import { describe, expect, test } from 'vitest'
import { db } from '../src/db.ts'
import { act, addMember, agent, createWorkspace, randomNumber } from './helpers.ts'

describe('recording notice', () => {
  test('on by default: call.start brings the default notice, with or without a settings row', async () => {
    const ws = await createWorkspace('Notice Default Plumbing')
    // Workspace creation stores a settings row with the column defaults.
    const [row] = await db.select().from(workspace_settings).where(eq(workspace_settings.workspace_id, ws.id))
    expect(row!.recording_notice_on).toBe(true)
    expect((await act(ws.owner, 'workspace.getSettings', {})).body.data).toMatchObject({
      recordingNoticeOn: true,
      recordingNotice: DEFAULT_RECORDING_NOTICE,
    })
    expect((await act(agent(), 'call.start', { from: randomNumber(), to: ws.number })).body.data.recordingNotice).toBe(
      DEFAULT_RECORDING_NOTICE,
    )
    // A workspace without a settings row (they are made lazily elsewhere) has it on too.
    const bare = await createWorkspace('Notice Bare Plumbing')
    await db.delete(workspace_settings).where(eq(workspace_settings.workspace_id, bare.id))
    expect((await act(bare.owner, 'workspace.getSettings', {})).body.data.recordingNoticeOn).toBe(true)
    expect(
      (await act(agent(), 'call.start', { from: randomNumber(), to: bare.number })).body.data.recordingNotice,
    ).toBe(DEFAULT_RECORDING_NOTICE)
  })

  test('off: call.start brings no notice; on again, the default or the owner’s own sentence', async () => {
    const ws = await createWorkspace('Notice Toggle Plumbing')
    expect((await act(ws.owner, 'workspace.updateSettings', { recordingNoticeOn: false })).body.data).toMatchObject({
      recordingNoticeOn: false,
    })
    expect(
      (await act(agent(), 'call.start', { from: randomNumber(), to: ws.number })).body.data.recordingNotice,
    ).toBeNull()
    expect((await act(ws.owner, 'workspace.updateSettings', { recordingNoticeOn: true })).status).toBe(200)
    expect((await act(agent(), 'call.start', { from: randomNumber(), to: ws.number })).body.data.recordingNotice).toBe(
      DEFAULT_RECORDING_NOTICE,
    )
    const own = 'This call is recorded for quality.'
    expect((await act(ws.owner, 'workspace.updateSettings', { recordingNotice: `  ${own} ` })).body.data).toMatchObject(
      {
        recordingNoticeOn: true,
        recordingNotice: own,
      },
    )
    expect((await act(agent(), 'call.start', { from: randomNumber(), to: ws.number })).body.data.recordingNotice).toBe(
      own,
    )
  })

  test('owners change it, members only read it; empty or very long sentences are refused; other workspaces untouched', async () => {
    const ws = await createWorkspace('Notice Rules Plumbing')
    const other = await createWorkspace('Notice Elsewhere Plumbing')
    const member = await addMember(ws.id, 'member')
    expect((await act(member, 'workspace.updateSettings', { recordingNoticeOn: false })).status).toBe(403)
    expect((await act(ws.owner, 'workspace.updateSettings', { recordingNotice: '   ' })).status).toBe(422)
    expect((await act(ws.owner, 'workspace.updateSettings', { recordingNotice: 'x'.repeat(201) })).status).toBe(422)
    await act(ws.owner, 'workspace.updateSettings', { recordingNoticeOn: false })
    expect((await act(member, 'workspace.getSettings', {})).body.data.recordingNoticeOn).toBe(false)
    expect((await act(other.owner, 'workspace.getSettings', {})).body.data.recordingNoticeOn).toBe(true)
  })
})
