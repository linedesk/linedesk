// The recording notice: a workspace setting (off by default) the assistant says right after the
// greeting. The agent gets it from call.start.
import { DEFAULT_RECORDING_NOTICE } from '@linedesk/actions'
import { describe, expect, test } from 'vitest'
import { act, addMember, agent, createWorkspace, randomNumber } from './helpers.ts'

describe('recording notice', () => {
  test('off by default: call.start brings no notice', async () => {
    const ws = await createWorkspace('Notice Off Plumbing')
    expect((await act(ws.owner, 'workspace.getSettings', {})).body.data).toMatchObject({
      recordingNoticeOn: false,
      recordingNotice: DEFAULT_RECORDING_NOTICE,
    })
    const call = await act(agent(), 'call.start', { from: randomNumber(), to: ws.number })
    expect(call.body.data.recordingNotice).toBeNull()
  })

  test('on: call.start brings the sentence, the default or the owner’s own', async () => {
    const ws = await createWorkspace('Notice On Plumbing')
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
    await act(ws.owner, 'workspace.updateSettings', { recordingNoticeOn: false })
    expect(
      (await act(agent(), 'call.start', { from: randomNumber(), to: ws.number })).body.data.recordingNotice,
    ).toBeNull()
  })

  test('owners change it, members only read it; empty or very long sentences are refused; other workspaces untouched', async () => {
    const ws = await createWorkspace('Notice Rules Plumbing')
    const other = await createWorkspace('Notice Elsewhere Plumbing')
    const member = await addMember(ws.id, 'member')
    expect((await act(member, 'workspace.updateSettings', { recordingNoticeOn: true })).status).toBe(403)
    expect((await act(ws.owner, 'workspace.updateSettings', { recordingNotice: '   ' })).status).toBe(422)
    expect((await act(ws.owner, 'workspace.updateSettings', { recordingNotice: 'x'.repeat(201) })).status).toBe(422)
    await act(ws.owner, 'workspace.updateSettings', { recordingNoticeOn: true })
    expect((await act(member, 'workspace.getSettings', {})).body.data.recordingNoticeOn).toBe(true)
    expect((await act(other.owner, 'workspace.getSettings', {})).body.data.recordingNoticeOn).toBe(false)
  })
})
