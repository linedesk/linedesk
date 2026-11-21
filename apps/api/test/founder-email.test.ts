// The personal email from a founder (founder-email.ts): off until an instance admin sets who it comes from; then once
// per workspace its owner made, 3 to 48 hours after sign-up, plain text from the founder's address with replies to
// them, and an unsubscribe link. Not to a partner's client, not to a workspace a server admin made and handed over,
// not to owners who turned setup emails off. Instance-wide (it sets an instance setting): INSTANCE_WIDE_FILES.
import { member_notification_settings, organization, partners, setup_emails, setup_events, user } from '@linedesk/db'
import { and, eq } from 'drizzle-orm'
import { beforeAll, describe, expect, test, vi } from 'vitest'
import { db } from '../src/db.ts'
import type { Email, EmailSender } from '../src/email.ts'
import { founderEmail, firstNameOf } from '../src/emails/templates.ts'
import { sendDueFounderEmails } from '../src/founder-email.ts'
import { act, asServerAdmin, createWorkspace, signUp, type User, type Workspace } from './helpers.ts'

const HOUR = 3_600_000
const FOUNDER = { name: 'Alex Example', email: 'alex@founder.test' }

function spySender(fail = false) {
  const sent: Email[] = []
  const sender: EmailSender = {
    kind: 'smtp',
    send: vi.fn(async (email: Email) => {
      if (fail) throw new Error('mail server down')
      sent.push(email)
    }),
    check: async () => ({ ok: true, message: '' }),
  }
  return { sender, sent }
}

/** Moves the sign-up and the workspace's creation `hours` back from now (a workspace its owner made). */
async function madeHoursAgo(ws: Workspace, hours: number, ownerJoinedLaterHours = 0) {
  const made = new Date(Date.now() - hours * HOUR)
  await db.update(organization).set({ createdAt: made }).where(eq(organization.id, ws.id))
  await db
    .update(setup_events)
    .set({ at: new Date(made.getTime() + ownerJoinedLaterHours * HOUR).toISOString() })
    .where(and(eq(setup_events.workspace_id, ws.id), eq(setup_events.event, 'signup')))
}

const founderSent = async (ws: Workspace) =>
  (await db.select().from(setup_emails).where(eq(setup_emails.workspace_id, ws.id))).some(
    r => r.kind === 'founder_hello',
  )

const ownerEmail = async (ws: Workspace) =>
  (await db.select({ email: user.email }).from(user).where(eq(user.id, ws.owner.userId)))[0]!.email
const toOwner = async (sent: Email[], ws: Workspace) => {
  const to = await ownerEmail(ws)
  return sent.filter(e => e.to === to)
}

let admin: User
const set = (sender: { name: string; email: string } | null) =>
  asServerAdmin(admin, () => act(admin, 'founderEmail.set', { sender }))

beforeAll(async () => {
  admin = await signUp()
})

describe('the text', () => {
  test("plain, greets by first name, signs with the founder's first name, ends with the unsubscribe link", () => {
    const { subject, text } = founderEmail({
      firstName: 'Mike',
      founder: FOUNDER,
      unsubscribeUrl: 'https://app.example/unsub',
    })
    expect(subject).toBe('Quick question')
    expect(text).toMatch(/^Hey Mike,\n\nI'm Alex, one of the co-founders of /)
    expect(text).toContain('By the way, I read every reply :)\n\n- Alex\n\n')
    expect(text.trimEnd().endsWith('Unsubscribe: https://app.example/unsub')).toBe(true)
  })

  test('no name: "Hey there,"', () => {
    expect(founderEmail({ firstName: null, founder: FOUNDER, unsubscribeUrl: 'u' }).text).toMatch(/^Hey there,/)
  })

  test.each([
    ['Mike Brennan', 'Mike'],
    ['  Mike ', 'Mike'],
    ['', null],
    [null, null],
    ['mike@example.com', null],
    ['User 123', 'User'],
    ['R2D2', null],
  ])('first name of %j: %j', (name, first) => {
    expect(firstNameOf(name)).toBe(first)
  })
})

describe('setting', () => {
  test('off by default; on with a sender; off again; instance admins only', async () => {
    expect((await asServerAdmin(admin, () => act(admin, 'founderEmail.get', {}))).body.data.sender).toBeNull()
    expect((await set(FOUNDER)).body.data.sender).toEqual(FOUNDER)
    expect((await asServerAdmin(admin, () => act(admin, 'founderEmail.get', {}))).body.data.sender).toEqual(FOUNDER)
    expect((await set(null)).body.data.sender).toBeNull()
    expect([401, 403]).toContain((await act(admin, 'founderEmail.set', { sender: FOUNDER })).status)
    expect((await set({ name: 'Alex', email: 'not an address' })).status).toBe(422)
  })
})

describe('sending', () => {
  test('off: nothing goes out', async () => {
    await set(null)
    const ws = await createWorkspace('Founder Off Plumbing')
    await madeHoursAgo(ws, 4)
    const { sender, sent } = spySender()
    expect(await sendDueFounderEmails(db, sender)).toMatchObject({ off: true })
    expect(await toOwner(sent, ws)).toHaveLength(0)
  })

  test('3 h after sign-up: once, from the founder, replies to them, plain text with an unsubscribe header', async () => {
    await set(FOUNDER)
    const ws = await createWorkspace('Founder Hello Plumbing')
    await db.update(user).set({ name: 'Mike Brennan' }).where(eq(user.id, ws.owner.userId))
    const { sender, sent } = spySender()
    await madeHoursAgo(ws, 2)
    await sendDueFounderEmails(db, sender)
    expect(await toOwner(sent, ws)).toHaveLength(0)
    await madeHoursAgo(ws, 4)
    await sendDueFounderEmails(db, sender)
    await sendDueFounderEmails(db, sender)
    const mine = await toOwner(sent, ws)
    expect(mine).toHaveLength(1)
    expect(mine[0]).toMatchObject({ from: '"Alex Example" <alex@founder.test>', replyTo: 'alex@founder.test' })
    expect(mine[0]!.html).toBeUndefined()
    expect(mine[0]!.text).toMatch(/^Hey Mike,/)
    expect(mine[0]!.headers?.['List-Unsubscribe']).toBeTruthy()
    expect(await founderSent(ws)).toBe(true)
  })

  test('a window that passed is skipped, never sent late', async () => {
    await set(FOUNDER)
    const ws = await createWorkspace('Founder Late Plumbing')
    await madeHoursAgo(ws, 50)
    const { sender, sent } = spySender()
    await sendDueFounderEmails(db, sender)
    expect(await toOwner(sent, ws)).toHaveLength(0)
  })

  test('a workspace a server admin made, whose owner joined later, gets none', async () => {
    await set(FOUNDER)
    const ws = await createWorkspace('Founder Admin Made Plumbing')
    await madeHoursAgo(ws, 30, 26)
    const { sender, sent } = spySender()
    await sendDueFounderEmails(db, sender)
    expect(await toOwner(sent, ws)).toHaveLength(0)
  })

  test("a white-label partner's client gets none", async () => {
    await set(FOUNDER)
    const ws = await createWorkspace('Founder Partner Client Plumbing')
    const [partner] = await db
      .insert(partners)
      .values({ id: `ptr_${ws.id}`, name: 'Founder Test Agency', created_by: admin.userId })
      .returning()
    await db.update(organization).set({ partnerId: partner!.id }).where(eq(organization.id, ws.id))
    await madeHoursAgo(ws, 4)
    const { sender, sent } = spySender()
    await sendDueFounderEmails(db, sender)
    expect(await toOwner(sent, ws)).toHaveLength(0)
  })

  test('an owner who turned setup emails off gets none, and nothing is marked sent', async () => {
    await set(FOUNDER)
    const ws = await createWorkspace('Founder Opted Out Plumbing')
    const owner = ws.owner.userId
    await db
      .insert(member_notification_settings)
      .values({ workspace_id: ws.id, user_id: owner, setup_emails: false, updated_by: owner })
    await madeHoursAgo(ws, 4)
    const { sender, sent } = spySender()
    await sendDueFounderEmails(db, sender)
    expect(await toOwner(sent, ws)).toHaveLength(0)
    expect(await founderSent(ws)).toBe(false)
  })

  test('when nothing could go out, the next run tries again', async () => {
    await set(FOUNDER)
    const ws = await createWorkspace('Founder Retry Plumbing')
    await madeHoursAgo(ws, 4)
    await sendDueFounderEmails(db, spySender(true).sender)
    expect(await founderSent(ws)).toBe(false)
    const { sender, sent } = spySender()
    await sendDueFounderEmails(db, sender)
    expect(await toOwner(sent, ws)).toHaveLength(1)
  })
})
