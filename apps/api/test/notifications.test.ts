// New-call notifications: each member's own settings (else the workspace default), the defaults
// only owners and admins change, and the email a finished call sends to whoever wants it.
import { calls, user } from '@linedesk/db'
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
      assignedEmail: true,
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

  test('only owners and admins change the defaults; members who kept them follow', async () => {
    const ws = await createWorkspace('Defaults Plumbing')
    const member = await addMember(ws.id, 'member')
    expect((await act(member, 'notifications.setDefaults', { email: false })).status).toBe(403)
    expect((await act(ws.owner, 'notifications.setDefaults', { email: false })).status).toBe(200)
    expect((await act(member, 'notifications.get', {})).body.data).toMatchObject({
      effective: { email: false },
      defaults: { email: false, browser: true },
    })
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
    const optedIn = await addMember(ws.id, 'member')
    const disabled = await addMember(ws.id, 'admin')
    await act(optedOut, 'notifications.update', { email: false })
    await act(ws.owner, 'notifications.setDefaults', { email: false })
    await act(optedIn, 'notifications.update', { email: true })
    await db.update(user).set({ disabledAt: new Date() }).where(eq(user.id, disabled.userId))
    const to = (await emailRecipients(db, ws.id)).map(r => r.email)
    expect(to).toEqual([await emailOf(optedIn)])
  })

  test('a finished call sends one email per recipient with topic, summary, next steps and a link', async () => {
    const ws = await createWorkspace('Email Plumbing')
    const call = await finishedCall(ws)
    const { sent, sender } = fakeSender()
    expect(await notifyCallFinished(db, sender, call.id)).toEqual({ sent: 1, failed: 0 })
    expect(sent[0]!.to).toBe(await emailOf(ws.owner))
    expect(sent[0]!.subject).toMatch(/^Urgent: Leak under the kitchen sink · /)
    expect(sent[0]!.text).toContain('Water on the floor')
    expect(sent[0]!.text).toContain('- Call back before noon')
    expect(sent[0]!.text).toContain(`/#call/${call.id}`)
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
