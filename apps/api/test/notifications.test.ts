// New-call notifications: each member's own settings (else the workspace default), the defaults
// only owners and admins change, and the email a finished call sends to whoever wants it.
import { calls, transcript_segments, user } from '@linedesk/db'
import { eq } from 'drizzle-orm'
import type { PgBoss } from 'pg-boss'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { emailRecipients, notifyCallFinished } from '../src/call-notifications.ts'
import { db } from '../src/db.ts'
import type { Email, EmailSender } from '../src/email.ts'
import { CALL_NOTIFY, setJobQueue } from '../src/jobs.ts'
import { act, addMember, agent, createWorkspace, getCall, randomNumber, type User, type Workspace } from './helpers.ts'

const emailOf = async (who: User) => (await db.select().from(user).where(eq(user.id, who.userId)))[0]!.email

function fakeSender(fail: (to: string) => boolean = () => false) {
  const sent: Email[] = []
  const sender: EmailSender = {
    kind: 'log',
    send: async email => {
      if (fail(email.to)) throw new Error('mailbox full')
      sent.push(email)
    },
    check: async () => ({ ok: true, message: '' }),
  }
  return { sent, sender }
}

async function finishedCall(ws: Workspace, values: Partial<typeof calls.$inferInsert> = {}) {
  const { body } = await act(agent(), 'call.start', { from: randomNumber(), to: ws.number })
  await act(agent(ws.id), 'call.finish', {
    callId: body.data.callId,
    title: 'Leak under the kitchen sink',
    summary: 'Water on the floor, wants someone today.',
    urgency: 'urgent',
    actionItems: [{ text: 'Call back before noon' }],
  })
  if (Object.keys(values).length) await db.update(calls).set(values).where(eq(calls.id, body.data.callId))
  return (await getCall(body.data.callId))!
}

afterEach(() => setJobQueue(null))

describe('notification settings', () => {
  test('everyone starts on the workspace default; a member changes only their own', async () => {
    const ws = await createWorkspace('Notify Plumbing')
    const member = await addMember(ws.id, 'member')
    const start = (await act(member, 'notifications.get', {})).body.data
    expect(start).toEqual({
      effective: { email: true, browser: true },
      own: { email: null, browser: null },
      defaults: { email: true, browser: true },
      canEditDefaults: false,
      push: { publicKey: null, devices: [], summary: false },
      setupEmails: null,
      assignedEmail: true,
      // The tests send no email (no SMTP_URL): the step and Settings say so.
      emailReady: !!process.env.SMTP_URL,
      // Nobody else changed them (Workspace settings › Team › Edit).
      changedBy: null,
    })

    expect((await act(member, 'notifications.update', { email: false })).status).toBe(200)
    expect((await act(member, 'notifications.get', {})).body.data).toMatchObject({
      effective: { email: false, browser: true },
      own: { email: false, browser: null },
    })
    // The owner is not touched by the member's choice.
    expect((await act(ws.owner, 'notifications.get', {})).body.data).toMatchObject({
      effective: { email: true, browser: true },
      canEditDefaults: true,
    })
    // null goes back to the default.
    await act(member, 'notifications.update', { email: null })
    expect((await act(member, 'notifications.get', {})).body.data.own.email).toBeNull()
  })

  test('only owners and admins change the defaults; they are for new teammates, members keep what they get', async () => {
    const ws = await createWorkspace('Defaults Plumbing')
    const member = await addMember(ws.id, 'member')
    const own = await addMember(ws.id, 'member')
    await act(own, 'notifications.update', { email: false })
    expect((await act(member, 'notifications.setDefaults', { email: false })).status).toBe(403)
    expect((await act(ws.owner, 'notifications.setDefaults', { email: false })).status).toBe(200)
    // Followed the default before (LIN-768): keeps every call email, now as their own setting, not as a change by
    // someone else.
    expect((await act(member, 'notifications.get', {})).body.data).toMatchObject({
      effective: { email: true },
      own: { email: true },
      defaults: { email: false, browser: true },
      changedBy: null,
    })
    expect((await act(own, 'notifications.get', {})).body.data.effective.email).toBe(false)
    // A teammate who joins now starts with the new default.
    const newcomer = await addMember(ws.id, 'member')
    expect((await act(newcomer, 'notifications.get', {})).body.data).toMatchObject({
      effective: { email: false },
      own: { email: null },
    })
    // The same default again pins nobody.
    expect((await act(ws.owner, 'notifications.setDefaults', { email: false })).status).toBe(200)
    expect((await act(newcomer, 'notifications.get', {})).body.data.own.email).toBeNull()
    const other = await createWorkspace('Other Defaults Plumbing')
    expect((await act(other.owner, 'notifications.get', {})).body.data.defaults).toEqual({ email: true, browser: true })
  })

  test('the voice agent has no notification settings', async () => {
    const ws = await createWorkspace('Agent Notify Plumbing')
    expect((await act(agent(ws.id), 'notifications.get', {})).status).toBe(403)
    expect((await act(agent(ws.id), 'notifications.update', { email: false })).status).toBe(403)
  })
})

describe('call emails', () => {
  test('go to members who want them: own choice first, then the workspace default; never to disabled users', async () => {
    const ws = await createWorkspace('Recipients Plumbing')
    const optedOut = await addMember(ws.id, 'member')
    await act(optedOut, 'notifications.update', { email: false })
    // The owner followed the default: keeps their call emails when it changes (LIN-768).
    await act(ws.owner, 'notifications.setDefaults', { email: false })
    const follows = await addMember(ws.id, 'member')
    const optedIn = await addMember(ws.id, 'member')
    const disabled = await addMember(ws.id, 'admin')
    await act(optedIn, 'notifications.update', { email: true })
    await act(disabled, 'notifications.update', { email: true })
    await db.update(user).set({ disabledAt: new Date() }).where(eq(user.id, disabled.userId))
    const to = (await emailRecipients(db, ws.id)).map(r => r.email).sort()
    expect(to).toEqual([await emailOf(ws.owner), await emailOf(optedIn)].sort())
    expect(to).not.toContain(await emailOf(follows))
  })

  test('a finished call sends one email per recipient with topic, summary, next steps and a link', async () => {
    const ws = await createWorkspace('Email Plumbing')
    const call = await finishedCall(ws, { fields: [{ label: 'Address', value: '12 Oak St' }] })
    const { sent, sender } = fakeSender()
    expect(await notifyCallFinished(db, sender, call.id)).toEqual({ sent: 1, failed: 0 })
    expect(sent[0]!.to).toBe(await emailOf(ws.owner))
    expect(sent[0]!.subject).toMatch(/^Urgent: Leak under the kitchen sink · /)
    expect(sent[0]!.text).toContain('Water on the floor')
    expect(sent[0]!.text).toContain('- Call back before noon')
    expect(sent[0]!.text).toContain(`/#call/${call.id}`)
    expect(sent[0]!.text).toContain('Key facts\nAddress: 12 Oak St')
    expect(sent[0]!.text).toContain(`Call back: ${call.from_number}`)
  })

  test('the email has the transcript in order, without tool and system lines', async () => {
    const ws = await createWorkspace('Transcript Email Plumbing')
    const call = await finishedCall(ws)
    const line = (speaker: 'agent' | 'caller' | 'human' | 'system', text: string, at_ms: number) => ({
      id: `${call.id}_${at_ms}`,
      workspace_id: ws.id,
      call_id: call.id,
      speaker,
      text,
      at_ms,
    })
    await db.insert(transcript_segments).values([
      line('caller', 'The sink is leaking.', 3000),
      line('agent', 'Brightwater, how can I help?', 1000),
      line('system', 'Transferred to Mike', 4000),
      {
        ...line('agent', 'Checking the calendar', 5000),
        tool_event: { tool: 'calendar.check', label: 'Checked the calendar' },
      },
      line('human', 'Mike here, I can come today.', 6000),
    ])
    const { sent, sender } = fakeSender()
    await notifyCallFinished(db, sender, call.id)
    expect(sent[0]!.text).toMatch(
      /Transcript\n[^\n:]+: Brightwater, how can I help\?\nCaller: The sink is leaking\.\nTeam: Mike here, I can come today\.\n/,
    )
    expect(sent[0]!.text).not.toMatch(/Transferred to Mike|Checking the calendar/)
  })

  test('test calls, spam and unfinished calls send nothing; one failed address does not stop the rest', async () => {
    const ws = await createWorkspace('Skip Plumbing')
    const { sender, sent } = fakeSender()
    expect((await notifyCallFinished(db, sender, (await finishedCall(ws, { source: 'test' })).id)).skipped).toBe('test')
    expect((await notifyCallFinished(db, sender, (await finishedCall(ws, { outcome: 'spam' })).id)).skipped).toBe(
      'spam',
    )
    expect((await notifyCallFinished(db, sender, (await finishedCall(ws, { status: 'live' })).id)).skipped).toBe(
      'unfinished',
    )
    expect(sent).toEqual([])

    const second = await addMember(ws.id, 'member')
    const owner = await emailOf(ws.owner)
    const failing = fakeSender(to => to === owner)
    expect(await notifyCallFinished(db, failing.sender, (await finishedCall(ws)).id)).toEqual({ sent: 1, failed: 1 })
    expect(failing.sent[0]!.to).toBe(await emailOf(second))
  })

  test('call.finish queues the emails once, inside its transaction', async () => {
    const ws = await createWorkspace('Queue Plumbing')
    const send = vi.fn(async (_name: string, _data: object, _options: object) => 'job-id')
    setJobQueue({ send } as unknown as PgBoss)
    const { body } = await act(agent(), 'call.start', { from: randomNumber(), to: ws.number })
    const notifications = () => send.mock.calls.filter(([name]) => name === CALL_NOTIFY)
    await act(agent(ws.id), 'call.finish', { callId: body.data.callId })
    expect(notifications()).toHaveLength(1)
    expect(notifications()[0]!.slice(0, 2)).toEqual([CALL_NOTIFY, { callId: body.data.callId }])
    expect(notifications()[0]![2]).toHaveProperty('db')
    await act(agent(ws.id), 'call.finish', { callId: body.data.callId })
    expect(notifications()).toHaveLength(1)
  })
})
