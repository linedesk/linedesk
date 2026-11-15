// Setup emails (setup-emails.ts): which one is due when, each once per workspace, only owners who did not turn them
// off, none of the "not live yet" ones once a real call came in. Turning them on for the install and the first-call
// email are instance-wide: those tests are in admin.test.ts.
import { calls, member, phone_numbers, setup_emails, setup_events } from '@linedesk/db'
import { and, eq, inArray } from 'drizzle-orm'
import { describe, expect, test, vi } from 'vitest'
import { db } from '../src/db.ts'
import type { Email, EmailSender } from '../src/email.ts'
import { PARTNER_DIRECTORY_URL } from '../src/emails/templates.ts'
import { dueSetupEmail, sendSetupEmailFor, setupRecipients } from '../src/setup-emails.ts'
import { act, addMember, agent, createWorkspace, randomNumber, type Workspace } from './helpers.ts'

const NOW = new Date().toISOString()
const HOUR = 3_600_000

function spySender(fail = false, kind: EmailSender['kind'] = 'smtp') {
  const sent: Email[] = []
  const sender: EmailSender = {
    kind,
    send: vi.fn(async (email: Email) => {
      if (fail) throw new Error('mail server down')
      sent.push(email)
    }),
    check: async () => ({ ok: true, message: '' }),
  }
  return { sender, sent }
}

/** Moves the workspace's sign-up `hours` back from NOW. */
const signedUpHoursAgo = (ws: Workspace, hours: number) =>
  db
    .update(setup_events)
    .set({ at: new Date(Date.parse(NOW) - hours * HOUR).toISOString() })
    .where(and(eq(setup_events.workspace_id, ws.id), eq(setup_events.event, 'signup')))

const sentKinds = async (ws: Workspace) =>
  (await db.select().from(setup_emails).where(eq(setup_emails.workspace_id, ws.id))).map(r => r.kind).sort()

/** A new workspace without the call the helper files for it: no real call has reached it yet. */
async function newWorkspace(name: string) {
  const ws = await createWorkspace(name)
  await db.delete(calls).where(eq(calls.id, ws.call.id))
  return ws
}

const phoneCall = async (ws: Workspace, outcome: string, urgency?: string) => {
  const callId = (await act(agent(), 'call.start', { from: randomNumber(), to: ws.number })).body.data.callId as string
  expect((await act(agent(ws.id), 'call.finish', { callId, outcome, ...(urgency ? { urgency } : {}) })).status).toBe(
    200,
  )
}

describe('which email is due', () => {
  const none = new Set<never>()
  test.each([
    [1, false, null],
    [3, false, 'setup_day0'],
    [30, false, 'setup_day1'],
    [80, false, 'setup_day3'],
    [8 * 24, false, null],
    [3, true, null],
    [80, true, null],
    [8 * 24, true, 'week_summary'],
    [10 * 24, true, null],
  ] as const)('%s h after sign-up, live %s: %s', (hoursSinceSignup, live, kind) => {
    expect(dueSetupEmail({ hoursSinceSignup, live, sent: none })).toBe(kind)
  })

  test('one already sent is not due again', () => {
    expect(dueSetupEmail({ hoursSinceSignup: 30, live: false, sent: new Set(['setup_day1']) })).toBeNull()
  })
})

describe('sending', () => {
  test('day 0 a few hours after sign-up, to owners only, once', async () => {
    const ws = await newWorkspace('Setup Day Zero Plumbing')
    await addMember(ws.id, 'admin')
    const { sender, sent } = spySender()
    expect(await sendSetupEmailFor(db, sender, ws.id, NOW)).toBeNull()
    await signedUpHoursAgo(ws, 3)
    expect(await sendSetupEmailFor(db, sender, ws.id, NOW)).toEqual({ kind: 'setup_day0', sent: 1, failed: 0 })
    expect(sent.map(e => e.to)).toEqual(await setupRecipients(db, ws.id))
    expect(sent[0]!.subject).toContain('almost ready')
    expect(sent[0]!.text).toContain("If you haven't yet, forward the calls you don't pick up")
    expect(sent[0]!.text).not.toContain('Find a partner')
    expect(sent[0]!.text).toContain(`#workspace/phone/`)
    expect(sent[0]!.text).toContain(`?ws=${ws.id}`)
    expect(await sendSetupEmailFor(db, sender, ws.id, NOW)).toBeNull()
    expect(sent).toHaveLength(1)
    expect(await sentKinds(ws)).toEqual(['setup_day0'])
  })

  test('day 1 and day 3 name the next step; day 3 offers a partner when the install has a directory', async () => {
    const ws = await newWorkspace('Setup Nudge Plumbing')
    await db.delete(phone_numbers).where(eq(phone_numbers.workspace_id, ws.id))
    const { sender, sent } = spySender()
    await signedUpHoursAgo(ws, 30)
    expect((await sendSetupEmailFor(db, sender, ws.id, NOW))?.kind).toBe('setup_day1')
    expect(sent[0]!.text).toContain('Pick a phone number')
    await signedUpHoursAgo(ws, 80)
    expect((await sendSetupEmailFor(db, sender, ws.id, NOW))?.kind).toBe('setup_day3')
    // PARTNER_DIRECTORY_URL (unset in tests); both cases are in templates.test.ts.
    expect(sent[1]!.text.includes('Find a partner')).toBe(!!PARTNER_DIRECTORY_URL)
    expect(await sentKinds(ws)).toEqual(['setup_day1', 'setup_day3'])
  })

  test('a window that passed is skipped, never sent late', async () => {
    const ws = await newWorkspace('Setup Late Plumbing')
    const { sender } = spySender()
    await signedUpHoursAgo(ws, 100)
    expect((await sendSetupEmailFor(db, sender, ws.id, NOW))?.kind).toBe('setup_day3')
    expect(await sentKinds(ws)).toEqual(['setup_day3'])
  })

  test('once a real call came in: no more setup emails; a week in, the summary of real calls', async () => {
    const ws = await newWorkspace('Setup Live Plumbing')
    await phoneCall(ws, 'message', 'urgent')
    await phoneCall(ws, 'booked')
    await phoneCall(ws, 'spam')
    await phoneCall(ws, 'hangup')
    const { sender, sent } = spySender()
    for (const hours of [3, 30, 80]) {
      await signedUpHoursAgo(ws, hours)
      expect(await sendSetupEmailFor(db, sender, ws.id, NOW)).toBeNull()
    }
    // The calls were just now, so they count from a sign-up a week back.
    await signedUpHoursAgo(ws, 7.5 * 24)
    expect((await sendSetupEmailFor(db, sender, ws.id, NOW))?.kind).toBe('week_summary')
    expect(sent).toHaveLength(1)
    expect(sent[0]!.text).toContain('Calls answered: 2')
    expect(sent[0]!.text).toContain('Urgent: 1')
    expect(sent[0]!.text).toContain('Appointments booked: 1')
    expect(sent[0]!.text).toContain('Messages taken: 1')
    expect(await sendSetupEmailFor(db, sender, ws.id, NOW)).toBeNull()
  })

  test('an owner who turned them off gets none, and nothing is marked sent for nobody', async () => {
    const ws = await newWorkspace('Setup Opt Out Plumbing')
    expect((await act(ws.owner, 'notifications.update', { setupEmails: false })).status).toBe(200)
    expect(await setupRecipients(db, ws.id)).toEqual([])
    const { sender, sent } = spySender()
    await signedUpHoursAgo(ws, 3)
    expect(await sendSetupEmailFor(db, sender, ws.id, NOW)).toBeNull()
    expect(sent).toEqual([])
    expect(await sentKinds(ws)).toEqual([])
    // Turned on again while day 0 is still due: it goes out then.
    expect((await act(ws.owner, 'notifications.update', { setupEmails: true })).status).toBe(200)
    expect(await sendSetupEmailFor(db, sender, ws.id, NOW)).toEqual({ kind: 'setup_day0', sent: 1, failed: 0 })
    expect(await sentKinds(ws)).toEqual(['setup_day0'])
  })

  test('a workspace without an owner (a server admin made it, the owner has not joined) gets no claim', async () => {
    const ws = await newWorkspace('Setup Ownerless Plumbing')
    await db.delete(member).where(eq(member.organizationId, ws.id))
    await signedUpHoursAgo(ws, 3)
    const { sender, sent } = spySender()
    expect(await sendSetupEmailFor(db, sender, ws.id, NOW)).toBeNull()
    expect(sent).toEqual([])
    expect(await sentKinds(ws)).toEqual([])
  })

  test('when nothing could go out, the next run tries again', async () => {
    const ws = await newWorkspace('Setup Retry Plumbing')
    await signedUpHoursAgo(ws, 3)
    expect(await sendSetupEmailFor(db, spySender(true).sender, ws.id, NOW)).toEqual({
      kind: 'setup_day0',
      sent: 0,
      failed: 1,
    })
    expect(await sentKinds(ws)).toEqual([])
    const { sender, sent } = spySender()
    expect((await sendSetupEmailFor(db, sender, ws.id, NOW))?.kind).toBe('setup_day0')
    expect(sent).toHaveLength(1)
  })

  test('real calls from before the milestones count as live: no nudges', async () => {
    const ws = await newWorkspace('Setup Early Calls Plumbing')
    await phoneCall(ws, 'message')
    await db
      .delete(setup_events)
      .where(and(eq(setup_events.workspace_id, ws.id), inArray(setup_events.event, ['first_real_call', 'activated'])))
    await signedUpHoursAgo(ws, 30)
    expect(await sendSetupEmailFor(db, spySender().sender, ws.id, NOW)).toBeNull()
  })

  test('while email only goes to the log (or nowhere), nothing is sent or marked sent', async () => {
    const ws = await newWorkspace('Setup Log Only Plumbing')
    await signedUpHoursAgo(ws, 3)
    for (const kind of ['log', 'none'] as const) {
      const { sender, sent } = spySender(false, kind)
      expect(await sendSetupEmailFor(db, sender, ws.id, NOW)).toBeNull()
      expect(sent).toEqual([])
    }
    expect(await sentKinds(ws)).toEqual([])
    expect((await sendSetupEmailFor(db, spySender().sender, ws.id, NOW))?.kind).toBe('setup_day0')
  })

  test('a workspace without a sign-up milestone (older than them) gets none', async () => {
    const ws = await newWorkspace('Setup Old Plumbing')
    await db.delete(setup_events).where(eq(setup_events.workspace_id, ws.id))
    expect(await sendSetupEmailFor(db, spySender().sender, ws.id, NOW)).toBeNull()
  })
})

test('notifications.get says setup emails are off while the install sends none', async () => {
  const ws = await newWorkspace('Setup Settings Plumbing')
  expect((await act(ws.owner, 'notifications.get', {})).body.data.setupEmails).toBeNull()
})
