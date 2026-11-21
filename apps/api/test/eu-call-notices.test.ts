// Call notices (legal review 2026-11-17, LIN-419): new assistants say at the start that they are an AI (A1); the owner
// keeps full control in every country (A2, A5: the settings only warn); turning the recording notice off or changing
// it is in the audit log (A4).
import { assistants } from '@linedesk/db'
import { eq } from 'drizzle-orm'
import { describe, expect, test } from 'vitest'
import { listAudit } from '../src/audit.ts'
import { db } from '../src/db.ts'
import { act, agent, createWorkspace, randomNumber } from './helpers.ts'

describe('AI disclosure (A1, A2)', () => {
  test('a new assistant says at the start that it is an AI', async () => {
    const ws = await createWorkspace('Disclosure Default Plumbing')
    const [row] = await db.select().from(assistants).where(eq(assistants.id, ws.assistant.id))
    expect(row!.ai_disclosure).toBe('at_start')
    expect(row!.greeting).toBe(
      'Thanks for calling Disclosure Default Plumbing. This is Maya, the AI assistant. How can I help?',
    )
  })

  test('a German workspace can pick every mode, and calls get the mode as saved', async () => {
    const de = await createWorkspace('Disclosure Berlin Sanitär')
    expect((await act(de.owner, 'workspace.updateSettings', { country: 'DE' })).status).toBe(200)
    for (const mode of ['never_confirm', 'never', 'when_asked', 'at_start_consent', 'at_start']) {
      const saved = await act(de.owner, 'assistant.update', { assistantId: de.assistant.id, ai_disclosure: mode })
      expect(saved.status, mode).toBe(200)
      const [row] = await db.select().from(assistants).where(eq(assistants.id, de.assistant.id))
      expect(row!.ai_disclosure).toBe(mode)
    }
    await act(de.owner, 'assistant.update', { assistantId: de.assistant.id, ai_disclosure: 'never_confirm' })
    const call = await act(agent(), 'call.start', { from: randomNumber(), to: de.number })
    expect(call.body.data.assistant.ai_disclosure).toBe('never_confirm')
  })
})

describe('recording (A5)', () => {
  test('a German workspace records by default like any other; the owner picks the retention', async () => {
    const ws = await createWorkspace('Recording Hamburg Sanitär')
    await act(ws.owner, 'workspace.updateSettings', { country: 'DE' })
    expect((await act(ws.owner, 'workspace.getSettings', {})).body.data.recordingRetentionDays).toBe(90)
    expect((await act(agent(), 'call.start', { from: randomNumber(), to: ws.number })).body.data.keepRecording).toBe(
      true,
    )
    await act(ws.owner, 'workspace.updateSettings', { recordingRetentionDays: 0 })
    expect((await act(agent(), 'call.start', { from: randomNumber(), to: ws.number })).body.data.keepRecording).toBe(
      false,
    )
  })
})

describe('recording notice changes in the audit log (A4)', () => {
  test('turning it off, on, and changing its text are listed; other settings are not', async () => {
    const ws = await createWorkspace('Notice Audit Plumbing')
    const assistantId = ws.assistant.id
    await act(ws.owner, 'assistant.update', { assistantId, recording_notice_on: false })
    await act(ws.owner, 'assistant.update', { assistantId, recording_notice_on: true })
    await act(ws.owner, 'assistant.update', { assistantId, recording_notice: 'Calls are recorded for training.' })
    await act(ws.owner, 'assistant.update', { assistantId, greeting: 'Hi, Brightwater Plumbing.' })
    await act(ws.owner, 'workspace.updateSettings', { businessHoursOn: true })
    const { entries } = await listAudit(db, { workspaceId: ws.id, limit: 50 })
    const notices = entries.filter(e => e.kind === 'team' && e.what === 'assistant.update')
    expect(notices.map(e => e.input)).toEqual([
      { assistantId, recording_notice: 'Calls are recorded for training.' },
      { assistantId, recording_notice_on: true },
      { assistantId, recording_notice_on: false },
    ])
    const team = await listAudit(db, { kind: 'team', workspaceId: ws.id, limit: 50 })
    expect(
      team.entries.filter(e => e.what === 'assistant.update' || e.what === 'workspace.updateSettings'),
    ).toHaveLength(3)
  })
})
