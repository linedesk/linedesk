// An owner deletes their own workspace (workspace.deleteOwn, workspace.deletePreview): only the owner, the name typed,
// a fresh sign-in (the passkey when they have one), every other member emailed, and accounts of members with no
// other workspace deleted (the owner's too unless they keep it). Instance admins are made here, so this file has
// a database of its own (vitest.config.ts, INSTANCE_WIDE_FILES).
import { commands, member, organization, passkey, session, user } from '@linedesk/db'
import { and, eq } from 'drizzle-orm'
import { afterEach, describe, expect, test } from 'vitest'
import { auth } from '../src/auth.ts'
import { db } from '../src/db.ts'
import { setJobQueue, WORKSPACE_DELETED_EMAIL, type WorkspaceDeletedJob } from '../src/jobs.ts'
import { deletedWhen, workspaceDeletedEmail } from '../src/emails/templates.ts'
import { act, addMember, agent, createWorkspace, request, type User } from './helpers.ts'

const queued: { name: string; data: WorkspaceDeletedJob }[] = []
function captureJobs() {
  queued.length = 0
  setJobQueue({
    insert: async (name: string, jobs: { data: WorkspaceDeletedJob }[]) =>
      void queued.push(...jobs.map(j => ({ name, data: j.data }))),
  } as never)
}

afterEach(() => {
  setJobQueue(null)
  process.env.ADMIN_SECOND_FACTOR = 'off'
})

const exists = async (id: string) => (await db.select().from(user).where(eq(user.id, id))).length === 1
const workspaceExists = async (id: string) =>
  (await db.select().from(organization).where(eq(organization.id, id))).length === 1
const emailOf = async (id: string) => (await db.select().from(user).where(eq(user.id, id)))[0]!.email
const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000)
/** Moves every session of this user back in time: as if they signed in `minutes` ago. */
const signedInAgo = (who: User, minutes: number, passkeyToo = false) =>
  db
    .update(session)
    .set({ createdAt: minutesAgo(minutes), ...(passkeyToo ? { passkeyVerifiedAt: minutesAgo(minutes) } : {}) })
    .where(eq(session.userId, who.userId))
const addPasskey = (who: User) =>
  db.insert(passkey).values({
    id: `pk_${crypto.randomUUID()}`,
    userId: who.userId,
    publicKey: 'key',
    credentialID: crypto.randomUUID(),
    counter: 0,
    deviceType: 'singleDevice',
    backedUp: false,
  })
const makeInstanceAdmin = (who: User) => db.update(user).set({ instanceAdmin: true }).where(eq(user.id, who.userId))
const join = (who: User, workspaceId: string, role: 'admin' | 'member' = 'member') =>
  auth.api.addMember({ body: { userId: who.userId, organizationId: workspaceId, role } })

describe('who may delete', () => {
  test('admins, members and the agent are refused; a wrong name too; the workspace stays', async () => {
    const ws = await createWorkspace('Only The Owner')
    const admin = await addMember(ws.id, 'admin')
    const plain = await addMember(ws.id, 'member')
    for (const who of [admin, plain]) {
      expect(await act(who, 'workspace.deleteOwn', { name: 'Only The Owner' })).toMatchObject({ status: 403 })
      expect(await act(who, 'workspace.deletePreview', {})).toMatchObject({ status: 403 })
    }
    expect(await act(admin, 'workspace.deleteOwn', { name: 'Only The Owner' })).toMatchObject({
      body: { error: 'missing permission workspace:own' },
    })
    expect(await act(agent(ws.id), 'workspace.deleteOwn', { name: 'Only The Owner' })).toMatchObject({ status: 403 })
    expect(await act(ws.owner, 'workspace.deleteOwn', { name: 'Not The Name' })).toMatchObject({
      status: 409,
      body: { error: "type the workspace's name, Only The Owner, to confirm" },
    })
    expect(await workspaceExists(ws.id)).toBe(true)
    expect(await exists(ws.owner.userId)).toBe(true)
  })

  test('an owner of another workspace cannot delete this one, even naming it', async () => {
    const ws = await createWorkspace('Not Theirs')
    const other = await createWorkspace('Their Own')
    const res = await act(other.owner, 'workspace.deleteOwn', { name: 'Not Theirs' }, undefined)
    // Their own workspace's name is asked for; this one's name does not match it.
    expect(res).toMatchObject({ status: 409 })
    const switched = await request(
      other.owner,
      'POST',
      '/v1/actions/workspace.deleteOwn',
      { name: 'Not Theirs' },
      { 'x-workspace-id': ws.id },
    )
    expect(switched.status).toBe(403)
    expect(await workspaceExists(ws.id)).toBe(true)
    expect(await workspaceExists(other.id)).toBe(true)
  })
})

describe('step-up', () => {
  test('without a passkey: a sign-in older than 10 minutes is refused with SIGN_IN_AGAIN, nothing deleted', async () => {
    const ws = await createWorkspace('Old Sign In')
    await signedInAgo(ws.owner, 11)
    expect((await act(ws.owner, 'workspace.deletePreview', {})).body.data.stepUp).toBe('signIn')
    expect(await act(ws.owner, 'workspace.deleteOwn', { name: 'Old Sign In' })).toMatchObject({
      status: 403,
      body: { code: 'SIGN_IN_AGAIN' },
    })
    expect(await workspaceExists(ws.id)).toBe(true)
    // Nothing reached the command log: the refusal came before the action ran.
    expect(
      await db
        .select()
        .from(commands)
        .where(and(eq(commands.action, 'workspace.deleteOwn'), eq(commands.workspace_id, ws.id))),
    ).toEqual([])
    await signedInAgo(ws.owner, 9)
    expect((await act(ws.owner, 'workspace.deletePreview', {})).body.data.stepUp).toBeNull()
  })

  test('with a passkey: only a passkey sign-in in the last 10 minutes counts', async () => {
    process.env.ADMIN_SECOND_FACTOR = 'on'
    const ws = await createWorkspace('Passkey Owner')
    await addPasskey(ws.owner)
    // A fresh password sign-in is not enough.
    expect((await act(ws.owner, 'workspace.deletePreview', {})).body.data.stepUp).toBe('passkey')
    expect(await act(ws.owner, 'workspace.deleteOwn', { name: 'Passkey Owner' })).toMatchObject({
      status: 403,
      body: { code: 'PASSKEY_STEP_UP_REQUIRED', stepUp: 'confirm' },
    })
    // A passkey sign-in an hour ago: not enough either (the admin area's 12 hours do not apply here).
    await signedInAgo(ws.owner, 60, true)
    expect(await act(ws.owner, 'workspace.deleteOwn', { name: 'Passkey Owner' })).toMatchObject({
      body: { code: 'PASSKEY_STEP_UP_REQUIRED' },
    })
    expect(await workspaceExists(ws.id)).toBe(true)
    await db.update(session).set({ passkeyVerifiedAt: new Date() }).where(eq(session.userId, ws.owner.userId))
    expect((await act(ws.owner, 'workspace.deletePreview', {})).body.data.stepUp).toBeNull()
    expect(await act(ws.owner, 'workspace.deleteOwn', { name: 'Passkey Owner' })).toMatchObject({ status: 200 })
    expect(await workspaceExists(ws.id)).toBe(false)
  })

  test('ADMIN_SECOND_FACTOR=off (no https for passkeys): a recent sign-in of any kind is enough', async () => {
    const ws = await createWorkspace('No Https Here')
    await addPasskey(ws.owner)
    expect((await act(ws.owner, 'workspace.deletePreview', {})).body.data.stepUp).toBeNull()
    await signedInAgo(ws.owner, 11)
    expect(await act(ws.owner, 'workspace.deleteOwn', { name: 'No Https Here' })).toMatchObject({
      status: 403,
      body: { code: 'SIGN_IN_AGAIN' },
    })
  })
})

describe('preview', () => {
  test('counts calls, contacts, numbers, other members and the accounts that go', async () => {
    const ws = await createWorkspace('Preview Plumbing')
    await addMember(ws.id, 'member') // only here: deleted
    const elsewhere = await addMember(ws.id, 'admin')
    await join(elsewhere, (await createWorkspace('Their Other One')).id)
    const operator = await addMember(ws.id, 'member')
    await makeInstanceAdmin(operator)
    const res = await act(ws.owner, 'workspace.deletePreview', {})
    expect(res).toMatchObject({
      status: 200,
      body: {
        data: {
          name: 'Preview Plumbing',
          calls: 1,
          contacts: 1,
          numbers: { bought: 0, attached: 1 },
          otherMembers: 3,
          accountsDeleted: 1,
          ownAccountDeleted: true,
          stepUp: null,
        },
      },
    })
  })

  test('the owner with another workspace, or an instance admin, keeps their account', async () => {
    const ws = await createWorkspace('Owner Elsewhere')
    await join(ws.owner, (await createWorkspace('Second Business')).id)
    expect((await act(ws.owner, 'workspace.deletePreview', {})).body.data.ownAccountDeleted).toBe(false)
    const admins = await createWorkspace('Operator Owned')
    await makeInstanceAdmin(admins.owner)
    expect((await act(admins.owner, 'workspace.deletePreview', {})).body.data.ownAccountDeleted).toBe(false)
  })
})

describe('deleting', () => {
  test("members only here lose their accounts, the others keep theirs; everyone else is emailed; the owner's goes too", async () => {
    const ws = await createWorkspace('Gone For Good')
    const onlyHere = await addMember(ws.id, 'member')
    const elsewhere = await addMember(ws.id, 'admin')
    const other = await createWorkspace('Still Here')
    await join(elsewhere, other.id)
    const operator = await addMember(ws.id, 'member')
    await makeInstanceAdmin(operator)
    const [ownerEmail, onlyHereEmail, elsewhereEmail, operatorEmail] = (await Promise.all(
      [ws.owner, onlyHere, elsewhere, operator].map(u => emailOf(u.userId)),
    )) as [string, string, string, string]
    captureJobs()
    const res = await act(ws.owner, 'workspace.deleteOwn', { name: ' gone for good ' })
    expect(res).toMatchObject({
      status: 200,
      body: {
        ok: true,
        data: { workspaceId: ws.id, name: 'Gone For Good', nextWorkspaceId: null, ownAccountDeleted: true },
      },
    })
    expect(res.body.data.usersDeleted.sort()).toEqual([ownerEmail, onlyHereEmail].sort())
    expect(await workspaceExists(ws.id)).toBe(false)
    expect(await exists(onlyHere.userId)).toBe(false)
    expect(await exists(ws.owner.userId)).toBe(false)
    expect(await exists(elsewhere.userId)).toBe(true)
    expect(await exists(operator.userId)).toBe(true)
    // The owner is signed out at once: their sessions went with the account.
    expect(await db.select().from(session).where(eq(session.userId, ws.owner.userId))).toEqual([])
    expect((await request(ws.owner, 'GET', '/v1/me')).status).toBe(401)
    // The member of another workspace lands there; the other workspace is untouched.
    expect((await request(elsewhere, 'GET', '/v1/me')).body.workspace).toMatchObject({ id: other.id })
    expect(await workspaceExists(other.id)).toBe(true)

    // One email to every other member, queued in the delete's transaction; never one to the owner.
    expect(queued.every(q => q.name === WORKSPACE_DELETED_EMAIL)).toBe(true)
    const byAddress = Object.fromEntries(queued.map(q => [q.data.to, q.data]))
    expect(Object.keys(byAddress).sort()).toEqual([onlyHereEmail, elsewhereEmail, operatorEmail].sort())
    expect(byAddress[onlyHereEmail]).toMatchObject({ workspace: 'Gone For Good', accountDeleted: true })
    expect(byAddress[elsewhereEmail]).toMatchObject({ accountDeleted: false })
    expect(byAddress[operatorEmail]).toMatchObject({ accountDeleted: false })
    // "Test User" is the fixture's name; the address says which one.
    expect(byAddress[onlyHereEmail]!.by).toBe(`Test User (${ownerEmail})`)
    expect(byAddress[onlyHereEmail]!.at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(workspaceDeletedEmail(byAddress[onlyHereEmail]!).text).toMatch(/\d{4} at \d{1,2}:\d{2}\s(AM|PM) /)

    // In the audit log, as the owner's.
    const [logged] = await db
      .select()
      .from(commands)
      .where(and(eq(commands.action, 'workspace.deleteOwn'), eq(commands.workspace_id, ws.id)))
    expect(logged).toMatchObject({ actor_id: ws.owner.userId, rejected: false, input: { name: 'gone for good' } })
  })

  test('keepOwnAccount keeps the owner, signed in, without a workspace', async () => {
    const ws = await createWorkspace('Keep Me')
    const res = await act(ws.owner, 'workspace.deleteOwn', { name: 'Keep Me', keepOwnAccount: true })
    expect(res).toMatchObject({
      status: 200,
      body: { data: { nextWorkspaceId: null, ownAccountDeleted: false, usersDeleted: [] } },
    })
    expect(await exists(ws.owner.userId)).toBe(true)
    expect((await db.select().from(session).where(eq(session.userId, ws.owner.userId))).length).toBeGreaterThan(0)
    expect(await db.select().from(member).where(eq(member.userId, ws.owner.userId))).toEqual([])
  })

  test('keepAccounts keeps every account, members and the owner, each without a workspace', async () => {
    const ws = await createWorkspace('Keep Them All')
    const onlyHere = await addMember(ws.id, 'member')
    const res = await act(ws.owner, 'workspace.deleteOwn', { name: 'Keep Them All', keepAccounts: true })
    expect(res).toMatchObject({ status: 200, body: { data: { ownAccountDeleted: false, usersDeleted: [] } } })
    expect(await workspaceExists(ws.id)).toBe(false)
    for (const kept of [onlyHere, ws.owner]) {
      expect(await exists(kept.userId)).toBe(true)
      expect(await db.select().from(member).where(eq(member.userId, kept.userId))).toEqual([])
    }
  })

  test('an owner with another workspace keeps the account and continues there', async () => {
    const ws = await createWorkspace('First Of Two')
    const second = await createWorkspace('Second Of Two')
    await join(ws.owner, second.id, 'admin')
    const res = await act(ws.owner, 'workspace.deleteOwn', { name: 'First Of Two' })
    expect(res).toMatchObject({ status: 200, body: { data: { nextWorkspaceId: second.id, ownAccountDeleted: false } } })
    expect(await exists(ws.owner.userId)).toBe(true)
    expect((await request(ws.owner, 'GET', '/v1/me')).body.workspace).toMatchObject({ id: second.id })
  })

  test('an instance admin who owns it keeps the account', async () => {
    const ws = await createWorkspace('Admin Owned')
    await makeInstanceAdmin(ws.owner)
    const res = await act(ws.owner, 'workspace.deleteOwn', { name: 'Admin Owned' })
    expect(res).toMatchObject({ status: 200, body: { data: { ownAccountDeleted: false } } })
    expect(await exists(ws.owner.userId)).toBe(true)
  })

  test('waits for a confirmed email address', async () => {
    const ws = await createWorkspace('Unconfirmed Owner', false)
    expect(await act(ws.owner, 'workspace.deleteOwn', { name: 'Unconfirmed Owner' })).toMatchObject({
      status: 403,
      body: { code: 'EMAIL_NOT_VERIFIED' },
    })
    expect(await workspaceExists(ws.id)).toBe(true)
  })
})

test('the time in the email is in the workspace time zone, UTC when unknown, in the reader language', () => {
  const plain = (text: string) => text.replace(/\s/g, ' ')
  expect(plain(deletedWhen('2026-11-14T17:05:00Z', 'America/Los_Angeles'))).toBe('November 14, 2026 at 9:05 AM PST')
  expect(plain(deletedWhen('2026-11-14T17:05:00Z', 'Not/AZone'))).toBe('November 14, 2026 at 5:05 PM UTC')
  expect(plain(deletedWhen('2026-11-14T17:05:00Z', null))).toBe('November 14, 2026 at 5:05 PM UTC')
  expect(deletedWhen('2026-11-14T17:05:00Z', 'Europe/Berlin', 'de')).toMatch(/^14\. November 2026 um 18:05 MEZ$/)
})
