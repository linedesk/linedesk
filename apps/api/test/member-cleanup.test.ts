// The lifecycle of a member around a workspace a server admin made or deleted, and around removal:
// - setup emails count from when the owner joined, never from when the admin typed the name (setup-emails.ts, memberships.ts);
// - a server admin's workspace.delete emails every member, saying whether their account went with it (admin-handlers.ts);
// - a removed or leaving member's calls are unassigned and their per-member rows go (memberships.ts, forgetMember).
import {
  calendar_oauth_states,
  calls,
  golive_checklist_dismissals,
  invitation,
  golive_checklist_steps,
  member,
  member_notification_settings,
  setup_emails,
  setup_events,
  user,
} from '@linedesk/db'
import { and, eq } from 'drizzle-orm'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { db } from '../src/db.ts'
import type { Email, EmailSender } from '../src/email.ts'
import { setJobQueue, WORKSPACE_DELETED_EMAIL, type WorkspaceDeletedJob } from '../src/jobs.ts'
import { workspaceDeletedEmail } from '../src/emails/templates.ts'
import { joinOnSignIn } from '../src/memberships.ts'
import { sendSetupEmailFor } from '../src/setup-emails.ts'
import {
  act,
  addMember,
  asServerAdmin,
  createWorkspace,
  FROM,
  randomIp,
  request,
  signUp,
  type User,
  type Workspace,
} from './helpers.ts'

const HOUR = 3_600_000
const address = (who: string) => `${who}_${crypto.randomUUID().slice(0, 8)}@linedesk.test`
const verify = (u: { userId: string }) => db.update(user).set({ emailVerified: true }).where(eq(user.id, u.userId))
const emailOf = async (id: string) => (await db.select().from(user).where(eq(user.id, id)))[0]!.email
const accountExists = async (id: string) => (await db.select().from(user).where(eq(user.id, id))).length === 1

async function serverAdmin(): Promise<User> {
  const admin = await signUp(address('operator'))
  await verify(admin)
  return admin
}

function spySender() {
  const sent: Email[] = []
  const sender: EmailSender = {
    kind: 'smtp',
    send: vi.fn(async (email: Email) => void sent.push(email)),
    check: async () => ({ ok: true, message: '' }),
  }
  return { sender, sent }
}

const signupOf = async (workspaceId: string) =>
  (
    await db
      .select()
      .from(setup_events)
      .where(and(eq(setup_events.workspace_id, workspaceId), eq(setup_events.event, 'signup')))
  )[0]
const claimsOf = async (workspaceId: string) =>
  (await db.select().from(setup_emails).where(eq(setup_emails.workspace_id, workspaceId))).map(r => r.kind)

describe('setup emails for a workspace a server admin made', () => {
  test('no clock and no day-0 claim before the owner joins; the clock starts at the join', async () => {
    const admin = await serverAdmin()
    const ownerEmail = address('owner')
    const made = await asServerAdmin(admin, () =>
      act(admin, 'workspace.create', {
        name: 'Cedar Ridge Landscaping',
        timeZone: 'America/Denver',
        owner: { email: ownerEmail, name: 'Dana Ruiz' },
      }),
    )
    expect(made.status).toBe(200)
    const workspaceId: string = made.body.data.workspace.id
    const ownerId: string = made.body.data.owner.userId
    expect(made.body.data.owner.joined).toBe('invited')

    // Made, but nobody owns it yet: no sign-up milestone, and nothing is claimed for nobody.
    expect(await signupOf(workspaceId)).toBeUndefined()
    const { sender, sent } = spySender()
    const hoursLater = new Date(Date.now() + 3 * HOUR).toISOString()
    expect(await sendSetupEmailFor(db, sender, workspaceId, hoursLater)).toBeNull()
    expect(await claimsOf(workspaceId)).toEqual([])

    // The owner proves the address and signs in: they join, and the clock starts now.
    await verify({ userId: ownerId })
    const joinedAt = new Date()
    expect(await db.transaction(tx => joinOnSignIn(tx, ownerId, joinedAt))).toEqual([workspaceId])
    expect(Date.parse((await signupOf(workspaceId))!.at)).toBe(joinedAt.getTime())

    // An hour after the join: too early. Three hours after: day 0 goes to the owner, once.
    expect(
      await sendSetupEmailFor(db, sender, workspaceId, new Date(joinedAt.getTime() + HOUR).toISOString()),
    ).toBeNull()
    const threeHours = new Date(joinedAt.getTime() + 3 * HOUR).toISOString()
    expect(await sendSetupEmailFor(db, sender, workspaceId, threeHours)).toEqual({
      kind: 'setup_day0',
      sent: 1,
      failed: 0,
    })
    expect(sent.map(e => e.to)).toEqual([ownerEmail])
    expect(await claimsOf(workspaceId)).toEqual(['setup_day0'])
  })

  test('an existing confirmed owner is added at once: the clock starts at creation, which is the join', async () => {
    const admin = await serverAdmin()
    const owner = await signUp(address('existing-owner'))
    await verify(owner)
    const email = await emailOf(owner.userId)
    const made = await asServerAdmin(admin, () =>
      act(admin, 'workspace.create', { name: 'Harbor View Dental', owner: { email } }),
    )
    expect(made.body.data.owner.joined).toBe('added')
    expect(await signupOf(made.body.data.workspace.id)).toBeDefined()
  })

  test("an owner who accepts on Better Auth's invitation page starts the clock", async () => {
    const admin = await serverAdmin()
    // An account from before, address not confirmed: Create workspace invites it (no auto-join).
    const existing = await signUp(address('unconfirmed-owner'))
    const email = await emailOf(existing.userId)
    const made = await asServerAdmin(admin, () =>
      act(admin, 'workspace.create', { name: 'Willow Creek Veterinary', owner: { email } }),
    )
    expect(made.body.data.owner.joined).toBe('invited')
    const workspaceId: string = made.body.data.workspace.id
    expect(await signupOf(workspaceId)).toBeUndefined()
    await verify(existing)
    const [invite] = await db.select().from(invitation).where(eq(invitation.organizationId, workspaceId))
    const accepted = await request(
      existing,
      'POST',
      '/api/auth/organization/accept-invitation',
      { invitationId: invite!.id },
      { [FROM]: randomIp() },
    )
    expect(accepted.status).toBe(200)
    expect(await memberRoleOf(workspaceId, existing)).toBe('owner')
    expect(await signupOf(workspaceId)).toBeDefined()
  })

  test('a server admin making a member the owner of an ownerless workspace starts the clock', async () => {
    const admin = await serverAdmin()
    const made = await asServerAdmin(admin, () =>
      act(admin, 'workspace.create', {
        name: 'Oak Hollow Fitness',
        owner: { email: address('owner'), name: 'Kim Lee' },
      }),
    )
    const workspaceId: string = made.body.data.workspace.id
    const manager = await signUp(address('manager'))
    await verify(manager)
    const added = await asServerAdmin(admin, () =>
      act(admin, 'membership.add', { userId: manager.userId, workspaceId, role: 'admin' }),
    )
    expect(added.status).toBe(200)
    expect(await signupOf(workspaceId)).toBeUndefined()
    const promoted = await asServerAdmin(admin, () =>
      act(admin, 'membership.setRole', { memberId: added.body.data.memberId, role: 'owner' }),
    )
    expect(promoted.status).toBe(200)
    expect(await signupOf(workspaceId)).toBeDefined()
  })

  test('a later owner (a hand-over) does not restart the clock', async () => {
    const ws = await createWorkspace('Pinecrest Auto Repair')
    const before = (await signupOf(ws.id))!.at
    const admin = await addMember(ws.id, 'admin')
    expect((await act(ws.owner, 'team.transferOwnership', { memberId: await memberIdOf(ws.id, admin) })).status).toBe(
      200,
    )
    expect((await signupOf(ws.id))!.at).toBe(before)
  })
})

const memberRoleOf = async (workspaceId: string, who: User) =>
  (
    await db
      .select({ role: member.role })
      .from(member)
      .where(and(eq(member.organizationId, workspaceId), eq(member.userId, who.userId)))
  )[0]?.role

const memberIdOf = async (workspaceId: string, who: User) =>
  (
    await db
      .select({ id: member.id })
      .from(member)
      .where(and(eq(member.organizationId, workspaceId), eq(member.userId, who.userId)))
  )[0]!.id

describe("a server admin's workspace.delete", () => {
  const queued: { name: string; data: WorkspaceDeletedJob }[] = []
  afterEach(() => setJobQueue(null))

  test('queues one email per member, with whether their account went; none to the admin', async () => {
    queued.length = 0
    setJobQueue({
      insert: async (name: string, jobs: { data: WorkspaceDeletedJob }[]) =>
        void queued.push(...jobs.map(j => ({ name, data: j.data }))),
    } as never)
    const ws = await createWorkspace('Summit Roofing Co')
    const onlyHere = await addMember(ws.id, 'member')
    const elsewhere = await addMember(ws.id, 'admin')
    const other = await createWorkspace('Summit Roofing Annex')
    await db.insert(member).values({
      id: crypto.randomUUID().replaceAll('-', ''),
      organizationId: other.id,
      userId: elsewhere.userId,
      role: 'member',
      createdAt: new Date(),
    })
    // The admin deleting it is a member too: they did it, so they get no email and keep their account.
    const admin = await addMember(ws.id, 'member')
    const [ownerEmail, onlyHereEmail, elsewhereEmail] = (await Promise.all(
      [ws.owner, onlyHere, elsewhere].map(u => emailOf(u.userId)),
    )) as [string, string, string]

    const res = await asServerAdmin(admin, () =>
      act(admin, 'workspace.delete', { workspaceId: ws.id, name: 'Summit Roofing Co' }),
    )
    expect(res.status).toBe(200)
    expect(await accountExists(onlyHere.userId)).toBe(false)
    expect(await accountExists(ws.owner.userId)).toBe(false)
    expect(await accountExists(elsewhere.userId)).toBe(true)
    expect(await accountExists(admin.userId)).toBe(true)

    expect(queued.every(q => q.name === WORKSPACE_DELETED_EMAIL)).toBe(true)
    expect(queued.map(q => q.data.to).sort()).toEqual([ownerEmail, onlyHereEmail, elsewhereEmail].sort())
    const byAddress = Object.fromEntries(queued.map(q => [q.data.to, q.data]))
    expect(byAddress[ownerEmail]).toMatchObject({ workspace: 'Summit Roofing Co', accountDeleted: true })
    expect(byAddress[onlyHereEmail]).toMatchObject({ accountDeleted: true })
    expect(byAddress[elsewhereEmail]).toMatchObject({ accountDeleted: false })
    expect(byAddress[onlyHereEmail]).toMatchObject({ by: null, byRole: 'serverAdmin' })
    const email = workspaceDeletedEmail(byAddress[onlyHereEmail]!)
    expect(email.text).toContain('The server admin of localhost:5173 deleted the workspace')
    expect(email.text).toMatch(/\d{4} at \d{1,2}:\d{2}\s(AM|PM) /)
  })

  test('a refused delete (wrong name) queues nothing', async () => {
    queued.length = 0
    setJobQueue({
      insert: async (name: string, jobs: { data: WorkspaceDeletedJob }[]) =>
        void queued.push(...jobs.map(j => ({ name, data: j.data }))),
    } as never)
    const ws = await createWorkspace('Lakeside Pet Clinic')
    await addMember(ws.id, 'member')
    const admin = await serverAdmin()
    const res = await asServerAdmin(admin, () =>
      act(admin, 'workspace.delete', { workspaceId: ws.id, name: 'Lakeside' }),
    )
    expect(res.status).toBe(409)
    expect(queued).toEqual([])
  })
})

describe('removal clears what the workspace kept of the member', () => {
  /** A member with an assigned call and every per-member row; one workspace-wide checklist row they set. */
  async function memberWithRows(ws: Workspace) {
    const who = await addMember(ws.id, 'member')
    await db.update(calls).set({ assignee_id: who.userId }).where(eq(calls.id, ws.call.id))
    await db.insert(member_notification_settings).values({ workspace_id: ws.id, user_id: who.userId, email: false })
    await db.insert(golive_checklist_dismissals).values({ workspace_id: ws.id, user_id: who.userId })
    await db.insert(golive_checklist_steps).values([
      {
        id: crypto.randomUUID(),
        workspace_id: ws.id,
        step: 'mobile',
        state: 'later',
        user_id: who.userId,
        by_user_id: who.userId,
        until: new Date().toISOString(),
      },
      {
        id: crypto.randomUUID(),
        workspace_id: ws.id,
        step: 'calendar',
        state: 'skipped',
        user_id: null,
        by_user_id: who.userId,
      },
    ])
    await db.insert(calendar_oauth_states).values({
      id: crypto.randomUUID(),
      workspace_id: ws.id,
      user_id: who.userId,
      provider: 'google',
      code_verifier: 'verifier',
      expires_at: new Date(Date.now() + HOUR).toISOString(),
    })
    return who
  }

  async function expectForgotten(ws: Workspace, who: User) {
    const [call] = await db.select().from(calls).where(eq(calls.id, ws.call.id))
    expect(call!.assignee_id).toBeNull()
    const mine = <T extends { workspace_id: unknown; user_id: unknown }>(t: T) =>
      and(eq(t.workspace_id as never, ws.id), eq(t.user_id as never, who.userId))
    expect(await db.select().from(member_notification_settings).where(mine(member_notification_settings))).toEqual([])
    expect(await db.select().from(golive_checklist_dismissals).where(mine(golive_checklist_dismissals))).toEqual([])
    expect(await db.select().from(golive_checklist_steps).where(mine(golive_checklist_steps))).toEqual([])
    expect(await db.select().from(calendar_oauth_states).where(mine(calendar_oauth_states))).toEqual([])
    // The workspace-wide row they set stays: it is the workspace's.
    const wide = await db.select().from(golive_checklist_steps).where(eq(golive_checklist_steps.workspace_id, ws.id))
    expect(wide).toEqual([expect.objectContaining({ step: 'calendar', user_id: null })])
  }

  test('team.removeMember: cleared, and the unassigned call comes back for the remover', async () => {
    const ws = await createWorkspace('Riverbend Electric')
    const who = await memberWithRows(ws)
    const res = await act(ws.owner, 'team.removeMember', { memberId: await memberIdOf(ws.id, who), keepAccount: true })
    expect(res.status).toBe(200)
    expect(res.body.rows.calls).toEqual([expect.objectContaining({ id: ws.call.id, assignee_id: null })])
    await expectForgotten(ws, who)
  })

  test('team.leave: cleared; nothing of the workspace is returned to the one leaving', async () => {
    const ws = await createWorkspace('Maple Street Bakery')
    const who = await memberWithRows(ws)
    const res = await act(who, 'team.leave', { deleteAccount: false })
    expect(res.status).toBe(200)
    expect(res.body.rows).toEqual({})
    await expectForgotten(ws, who)
  })

  test('membership.remove (server admin): cleared; no call rows go to the admin', async () => {
    const ws = await createWorkspace('Granite Peak HVAC')
    const who = await memberWithRows(ws)
    const admin = await serverAdmin()
    const res = await asServerAdmin(admin, async () =>
      act(admin, 'membership.remove', { memberId: await memberIdOf(ws.id, who), keepAccount: true }),
    )
    expect(res.status).toBe(200)
    expect(res.body.rows).toEqual({})
    await expectForgotten(ws, who)
  })

  test('only this workspace: the same person assigned in another workspace keeps that call', async () => {
    const ws = await createWorkspace('Bayside Plumbing')
    const other = await createWorkspace('Bayside Plumbing North')
    const who = await memberWithRows(ws)
    await db.insert(member).values({
      id: crypto.randomUUID().replaceAll('-', ''),
      organizationId: other.id,
      userId: who.userId,
      role: 'member',
      createdAt: new Date(),
    })
    await db.update(calls).set({ assignee_id: who.userId }).where(eq(calls.id, other.call.id))
    await db.insert(member_notification_settings).values({ workspace_id: other.id, user_id: who.userId, email: false })
    expect((await act(ws.owner, 'team.removeMember', { memberId: await memberIdOf(ws.id, who) })).status).toBe(200)
    await expectForgotten(ws, who)
    expect((await db.select().from(calls).where(eq(calls.id, other.call.id)))[0]!.assignee_id).toBe(who.userId)
    expect(
      await db
        .select()
        .from(member_notification_settings)
        .where(
          and(
            eq(member_notification_settings.workspace_id, other.id),
            eq(member_notification_settings.user_id, who.userId),
          ),
        ),
    ).toHaveLength(1)
    // In another workspace: the account stays.
    expect(await accountExists(who.userId)).toBe(true)
  })
})
