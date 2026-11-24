// The daily data purges (src/data-purge.ts; legal research A7, A8): calls and contacts deleted more than 30 days ago are
// erased with their recordings and the rows that belong only to them; 90 days after a bill was canceled its workspaces
// are deleted, and what accounting needs (the bill, its invoices, the ledger) stays. Both are idempotent, have a dry
// run and write an audit entry. Billing is switched on by replacing billingState. Instance-wide: the purges look at
// every workspace of the database, so other files' deleted calls and canceled bills must not be in it.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { recordingKey } from '@linedesk/actions'
import {
  billing_accounts,
  billing_invoices,
  bookings,
  call_evaluations,
  calls,
  commands,
  contacts,
  knowledge_questions,
  member,
  organization,
  partner_members,
  partners,
  transcript_segments,
  user,
} from '@linedesk/db'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  DELETED_RESTORE_DAYS,
  ERASE_NOW_ACTION,
  PURGE_ACTOR,
  purgeCanceled,
  purgeDeleted,
  purgeDryRun,
} from '../src/data-purge.ts'
import { db } from '../src/db.ts'
import { createFileRecordingStore, type RecordingStore } from '../src/recording-store.ts'
import { seatsFollowDelete } from '../src/partner-billing.ts'
import { act, addMember, createWorkspace, getCall, getContact, randomNumber, type Workspace } from './helpers.ts'

const cloud = vi.hoisted(() => ({ on: true }))
vi.mock('../src/billing-settings.ts', async original => {
  const real = await original<typeof import('../src/billing-settings.ts')>()
  return {
    ...real,
    billingState: async (...args: Parameters<typeof real.billingState>) =>
      cloud.on ? { ...(await real.billingState(...args)), inEffect: 'stripe' as const } : real.billingState(...args),
  }
})
beforeEach(() => {
  cloud.on = true
})
// The recording files a delete queues for the recording.fileDelete job (there is no job queue in the tests).
const queued = vi.hoisted(() => ({ files: [] as { key: string }[] }))
vi.mock('../src/jobs.ts', async original => {
  const real = await original<typeof import('../src/jobs.ts')>()
  return {
    ...real,
    queueRecordingFileDeletions: async (...args: Parameters<typeof real.queueRecordingFileDeletions>) => {
      queued.files.push(...args[1])
      return real.queueRecordingFileDeletions(...args)
    },
  }
})
// The workspaces whose seats and extra calls follow a delete (the same path as Delete workspace).
const seats = vi.hoisted(() => ({ deleted: [] as string[] }))
vi.mock('../src/partner-billing.ts', async original => {
  const real = await original<typeof import('../src/partner-billing.ts')>()
  return {
    ...real,
    seatsFollowDelete: async (...args: Parameters<typeof real.seatsFollowDelete>) => {
      seats.deleted.push(args[2])
      return real.seatsFollowDelete(...args)
    },
  }
})

const DAY = 86_400_000
const NOW = new Date().toISOString()
const daysAgo = (days: number) => new Date(Date.parse(NOW) - days * DAY).toISOString()
const rid = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`

let dir: string
let store: RecordingStore
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'linedesk-purge-'))
  store = createFileRecordingStore(dir)
})
afterAll(() => rm(dir, { recursive: true, force: true }))
const storeFor = () => store
const fileExists = (key: string) =>
  readFile(join(dir, key)).then(
    () => true,
    () => false,
  )

/** A finished call deleted `deletedDaysAgo` days ago (null: not deleted), with a recording file and a transcript. */
async function deletedCall(
  ws: Workspace,
  deletedDaysAgo: number | null,
  over: Partial<typeof calls.$inferInsert> = {},
) {
  const id = rid('call')
  const key = recordingKey(ws.id, id)
  await db.insert(calls).values({
    id,
    workspace_id: ws.id,
    from_number: randomNumber(),
    to_number: ws.number,
    status: 'completed',
    started_at: daysAgo(60),
    ended_at: daysAgo(60),
    summary: 'Leak under the kitchen sink.',
    recording_key: key,
    deleted_at: deletedDaysAgo === null ? null : daysAgo(deletedDaysAgo),
    ...over,
  })
  await mkdir(dirname(join(dir, key)), { recursive: true })
  await writeFile(join(dir, key), 'audio')
  await db.insert(transcript_segments).values({
    id: crypto.randomUUID(),
    workspace_id: ws.id,
    call_id: id,
    speaker: 'caller',
    text: 'My kitchen sink is leaking.',
    at_ms: 1000,
  })
  return { id, key }
}

const auditOf = (workspaceId: string, action: string) =>
  db
    .select()
    .from(commands)
    .where(and(eq(commands.workspace_id, workspaceId), eq(commands.action, action)))

describe('A7: deleted calls and contacts after 30 days', () => {
  test('a call deleted 31 days ago goes with its recording, transcript, evaluation and open questions', async () => {
    const ws = await createWorkspace('Purge Calls Plumbing')
    const old = await deletedCall(ws, DELETED_RESTORE_DAYS + 1)
    await db
      .insert(call_evaluations)
      .values({ call_id: old.id, workspace_id: ws.id, score: 3, issues: ['Missed the name'] })
    const [open] = await db
      .insert(knowledge_questions)
      .values({
        id: rid('kq'),
        workspace_id: ws.id,
        assistant_id: ws.assistant.id,
        call_id: old.id,
        question: 'Do you fix boilers?',
      })
      .returning()
    const [answered] = await db
      .insert(knowledge_questions)
      .values({
        id: rid('kq'),
        workspace_id: ws.id,
        assistant_id: ws.assistant.id,
        call_id: old.id,
        question: 'Are you open on Sundays?',
        status: 'answered',
      })
      .returning()
    const [booking] = await db
      .insert(bookings)
      .values({
        id: rid('bk'),
        workspace_id: ws.id,
        call_id: old.id,
        start_at: daysAgo(50),
        end_at: daysAgo(50 - 0.05),
      })
      .returning()

    const result = await purgeDeleted(db, storeFor, { now: NOW })
    expect(result.calls).toContain(old.id)
    expect(await getCall(old.id)).toBeUndefined()
    expect(await fileExists(old.key)).toBe(false)
    expect(await db.select().from(transcript_segments).where(eq(transcript_segments.call_id, old.id))).toEqual([])
    expect(await db.select().from(call_evaluations).where(eq(call_evaluations.call_id, old.id))).toEqual([])
    expect(await db.select().from(knowledge_questions).where(eq(knowledge_questions.id, open!.id))).toEqual([])
    // An answered question became an FAQ; a booking is the calendar's. Both stay, without the link.
    expect(
      (await db.select().from(knowledge_questions).where(eq(knowledge_questions.id, answered!.id)))[0],
    ).toMatchObject({ call_id: null })
    expect((await db.select().from(bookings).where(eq(bookings.id, booking!.id)))[0]).toMatchObject({ call_id: null })

    const [audit] = await auditOf(ws.id, 'data.purgeDeleted')
    expect(audit).toMatchObject({ actor_id: PURGE_ACTOR, input: { calls: 1, contacts: 0, recordings: 1, days: 30 } })
    expect(audit!.result).toMatchObject({ ok: true, data: { callIds: [old.id], contactIds: [] } })
  })

  test('a call deleted 29 days ago, one not deleted and a live one stay', async () => {
    const ws = await createWorkspace('Purge Keeps Plumbing')
    const recent = await deletedCall(ws, DELETED_RESTORE_DAYS - 1)
    const kept = await deletedCall(ws, null)
    const live = await deletedCall(ws, 40, { status: 'live', ended_at: null })
    await purgeDeleted(db, storeFor, { now: NOW })
    for (const call of [recent, kept, live]) {
      expect((await getCall(call.id))?.recording_key).toBe(call.key)
      expect(await fileExists(call.key)).toBe(true)
    }
    expect(await auditOf(ws.id, 'data.purgeDeleted')).toEqual([])
  })

  test('a dry run reports what is due and deletes nothing', async () => {
    const ws = await createWorkspace('Purge Dry Run Plumbing')
    const old = await deletedCall(ws, 45)
    const result = await purgeDeleted(db, storeFor, { now: NOW, dryRun: true })
    expect(result).toMatchObject({ dryRun: true })
    expect(result.calls).toContain(old.id)
    expect((await getCall(old.id))?.recording_key).toBe(old.key)
    expect(await fileExists(old.key)).toBe(true)
    expect(await auditOf(ws.id, 'data.purgeDeleted')).toEqual([])
    expect(purgeDryRun({ DATA_PURGE_DRY_RUN: 'true' })).toBe(true)
    expect(purgeDryRun({})).toBe(false)
    await purgeDeleted(db, storeFor, { now: NOW })
  })

  test('a recording the store refuses keeps its call for the next run; a second run deletes nothing more', async () => {
    const ws = await createWorkspace('Purge Retry Plumbing')
    const old = await deletedCall(ws, 35)
    const refusing = { ...store, delete: async () => Promise.reject(new Error('store down')) } as RecordingStore
    const first = await purgeDeleted(db, () => refusing, { now: NOW })
    expect(first.failed).toContain(old.id)
    expect(await getCall(old.id)).toBeDefined()

    await purgeDeleted(db, storeFor, { now: NOW })
    expect(await getCall(old.id)).toBeUndefined()
    const again = await purgeDeleted(db, storeFor, { now: NOW })
    expect(again.calls).not.toContain(old.id)
    expect(await auditOf(ws.id, 'data.purgeDeleted')).toHaveLength(1)
  })

  test('a deleted contact goes after 30 days; its calls stay without the link; a merged one waits for its contact', async () => {
    const ws = await createWorkspace('Purge Contacts Plumbing')
    // The helper's call is not deleted and links the contact.
    await db
      .update(contacts)
      .set({ deleted_at: daysAgo(31) })
      .where(eq(contacts.id, ws.contact.id))
    const [keep] = await db
      .insert(contacts)
      .values({ id: rid('ct'), workspace_id: ws.id, phone: randomNumber(), name: 'Sam Patel' })
      .returning()
    const [merged] = await db
      .insert(contacts)
      .values({
        id: rid('ct'),
        workspace_id: ws.id,
        phone: randomNumber(),
        deleted_at: daysAgo(60),
        merged_into: keep!.id,
      })
      .returning()
    const [recent] = await db
      .insert(contacts)
      .values({ id: rid('ct'), workspace_id: ws.id, phone: randomNumber(), deleted_at: daysAgo(5) })
      .returning()
    const [booking] = await db
      .insert(bookings)
      .values({
        id: rid('bk'),
        workspace_id: ws.id,
        contact_id: ws.contact.id,
        start_at: daysAgo(10),
        end_at: daysAgo(9.9),
      })
      .returning()

    await purgeDeleted(db, storeFor, { now: NOW })
    expect(await getContact(ws.contact.id)).toBeUndefined()
    expect((await getCall(ws.call.id))?.contact_id).toBeNull()
    expect((await db.select().from(bookings).where(eq(bookings.id, booking!.id)))[0]).toMatchObject({
      contact_id: null,
    })
    // The merged contact forwards its number to Sam Patel, who is not deleted; the recent one can still be restored.
    expect(await getContact(merged!.id)).toBeDefined()
    expect(await getContact(recent!.id)).toBeDefined()

    await db
      .update(contacts)
      .set({ deleted_at: daysAgo(31) })
      .where(eq(contacts.id, keep!.id))
    await purgeDeleted(db, storeFor, { now: NOW })
    expect(await getContact(keep!.id)).toBeUndefined()
    await purgeDeleted(db, storeFor, { now: NOW })
    expect(await getContact(merged!.id)).toBeUndefined()
    const counted = (await auditOf(ws.id, 'data.purgeDeleted')).map(a => (a.input as { contacts: number }).contacts)
    expect(counted).toEqual(expect.arrayContaining([1, 1, 1]))
  })
})

describe('A7: Delete permanently now (call.delete with permanent)', () => {
  /** A call of `ws` with an evaluation, an open and an answered knowledge question. */
  async function callWithData(ws: Workspace, over: Partial<typeof calls.$inferInsert> = {}) {
    const call = await deletedCall(ws, null, over)
    await db.insert(call_evaluations).values({ call_id: call.id, workspace_id: ws.id, score: 2, issues: ['Wrong hours'] })
    const question = (status: 'open' | 'answered') =>
      db
        .insert(knowledge_questions)
        .values({
          id: rid('kq'),
          workspace_id: ws.id,
          assistant_id: ws.assistant.id,
          call_id: call.id,
          question: status === 'open' ? 'Do you work on Sundays?' : 'Do you fix taps?',
          status,
        })
        .returning()
    const [open] = await question('open')
    const [answered] = await question('answered')
    return { ...call, open: open!, answered: answered! }
  }
  const questionOf = async (id: string) =>
    (await db.select().from(knowledge_questions).where(eq(knowledge_questions.id, id)))[0]
  const segmentsOf = (callId: string) =>
    db.select().from(transcript_segments).where(eq(transcript_segments.call_id, callId))

  test('the owner erases a call at once, exactly as the purge does, with an audit entry', async () => {
    const ws = await createWorkspace('Erase Now Plumbing')
    const call = await callWithData(ws)
    queued.files = []
    const { status, body } = await act(ws.owner, 'call.delete', { callId: call.id, permanent: true })
    expect(status, JSON.stringify(body)).toBe(200)
    expect(await getCall(call.id)).toBeUndefined()
    expect(await segmentsOf(call.id)).toEqual([])
    expect(await db.select().from(call_evaluations).where(eq(call_evaluations.call_id, call.id))).toEqual([])
    expect(await questionOf(call.open.id)).toBeUndefined()
    // An answered question became an FAQ: it stays, without the call.
    expect(await questionOf(call.answered.id)).toMatchObject({ status: 'answered', call_id: null })
    // The recording file is deleted after the commit, by the recording.fileDelete job.
    expect(queued.files).toEqual([expect.objectContaining({ key: call.key })])
    const [audit] = await auditOf(ws.id, ERASE_NOW_ACTION)
    expect(audit).toMatchObject({ actor_id: ws.owner.userId, input: { calls: 1, recordings: 1 } })
    expect(audit!.result).toMatchObject({ ok: true, data: { callIds: [call.id] } })
    // Gone for good: nothing to restore.
    expect((await act(ws.owner, 'call.restore', { callId: call.id })).status).not.toBe(200)
  })

  test('an admin may; a member may not (403, nothing happens), but deletes it restorable', async () => {
    const ws = await createWorkspace('Erase Rights Plumbing')
    const admin = await addMember(ws.id, 'admin')
    const memberUser = await addMember(ws.id, 'member')
    const byAdmin = await callWithData(ws)
    expect((await act(admin, 'call.delete', { callId: byAdmin.id, permanent: true })).status).toBe(200)
    expect(await getCall(byAdmin.id)).toBeUndefined()

    const byMember = await callWithData(ws)
    const refused = await act(memberUser, 'call.delete', { callId: byMember.id, permanent: true })
    expect(refused.status).toBe(403)
    // The whole action was refused: not even deleted.
    expect(await getCall(byMember.id)).toMatchObject({ deleted_at: null })
    expect(await segmentsOf(byMember.id)).toHaveLength(1)
    expect(await auditOf(ws.id, ERASE_NOW_ACTION)).toHaveLength(1)

    // Without the flag (or with false) a member deletes it as before: restorable for 30 days.
    expect((await act(memberUser, 'call.delete', { callId: byMember.id, permanent: false })).status).toBe(200)
    expect((await getCall(byMember.id))?.deleted_at).toBeTruthy()
    expect(await segmentsOf(byMember.id)).toHaveLength(1)
    expect((await act(memberUser, 'call.restore', { callId: byMember.id })).status).toBe(200)
    expect(await getCall(byMember.id)).toMatchObject({ deleted_at: null })
  })

  test("never reaches another workspace's call, and refuses a live call", async () => {
    const ws = await createWorkspace('Erase Scope Plumbing')
    const other = await createWorkspace('Erase Other Plumbing')
    const theirs = await callWithData(other)
    const res = await act(ws.owner, 'call.delete', { callId: theirs.id, permanent: true })
    expect(res.status).not.toBe(200)
    expect(await getCall(theirs.id)).toMatchObject({ deleted_at: null, workspace_id: other.id })
    expect(await segmentsOf(theirs.id)).toHaveLength(1)
    expect(await questionOf(theirs.open.id)).toBeDefined()
    expect(await auditOf(ws.id, ERASE_NOW_ACTION)).toEqual([])
    expect(await auditOf(other.id, ERASE_NOW_ACTION)).toEqual([])

    const live = await callWithData(ws, { status: 'live', ended_at: null })
    const refused = await act(ws.owner, 'call.delete', { callId: live.id, permanent: true })
    expect(refused.status).not.toBe(200)
    expect(JSON.stringify(refused.body)).toContain('live call cannot be deleted permanently')
    expect(await getCall(live.id)).toMatchObject({ deleted_at: null, status: 'live' })
  })
})

describe('A8: workspaces 90 days after their bill was canceled', () => {
  /** `ws` on a bill canceled `daysAgo` days ago, with a paid invoice. */
  async function canceledBill(ws: Workspace, canceledDaysAgo: number) {
    const billId = rid('bill')
    await db.insert(billing_accounts).values({
      id: billId,
      kind: 'cloud',
      owner_user_id: ws.owner.userId,
      status: 'canceled',
      canceled_at: daysAgo(canceledDaysAgo),
      stripe_customer_id: rid('cus'),
    })
    await db.insert(billing_invoices).values({
      stripe_invoice_id: rid('in'),
      billing_account_id: billId,
      kind: 'subscription',
      number: 'LD-0001',
      status: 'paid',
      total_cents: 10_800,
    })
    await db
      .update(organization)
      .set({ billingAccountId: billId, billingState: 'suspended' })
      .where(eq(organization.id, ws.id))
    return billId
  }
  const workspaceRow = async (id: string) => (await db.select().from(organization).where(eq(organization.id, id)))[0]
  const account = async (id: string) => (await db.select().from(user).where(eq(user.id, id)))[0]

  test('deleted with all its data and the owner account; the bill and its invoices stay; an audit entry', async () => {
    const ws = await createWorkspace('Canceled Long Ago Plumbing')
    const billId = await canceledBill(ws, 91)
    const result = await purgeCanceled(db, { now: NOW })
    expect(result.workspaces).toContain(ws.id)
    expect(await workspaceRow(ws.id)).toBeUndefined()
    expect(await getCall(ws.call.id)).toBeUndefined()
    expect(await getContact(ws.contact.id)).toBeUndefined()
    expect(await account(ws.owner.userId)).toBeUndefined()
    // Accounting: the bill and its invoices.
    expect((await db.select().from(billing_accounts).where(eq(billing_accounts.id, billId)))[0]).toMatchObject({
      status: 'canceled',
      owner_user_id: ws.owner.userId,
    })
    expect(
      await db.select().from(billing_invoices).where(eq(billing_invoices.billing_account_id, billId)),
    ).toHaveLength(1)

    const [audit] = await auditOf(ws.id, 'workspace.purge')
    expect(audit).toMatchObject({
      actor_id: PURGE_ACTOR,
      input: { workspaceId: ws.id, name: 'Canceled Long Ago Plumbing', billId, days: 90 },
    })
    expect(audit!.result).toMatchObject({ ok: true, data: { workspaceId: ws.id, ownerAccountDeleted: true } })

    // Idempotent: nothing left to do for it.
    expect((await purgeCanceled(db, { now: NOW })).workspaces).not.toContain(ws.id)
    expect(await auditOf(ws.id, 'workspace.purge')).toHaveLength(1)
  })

  test('canceled 89 days ago, a running bill, a dry run and billing off: nothing is deleted', async () => {
    const recent = await createWorkspace('Canceled Recently Plumbing')
    await canceledBill(recent, 89)
    const running = await createWorkspace('Running Bill Plumbing')
    const runningBill = await canceledBill(running, 200)
    await db
      .update(billing_accounts)
      .set({ status: 'active', canceled_at: null })
      .where(eq(billing_accounts.id, runningBill))
    const due = await createWorkspace('Dry Run Canceled Plumbing')
    await canceledBill(due, 120)

    const dry = await purgeCanceled(db, { now: NOW, dryRun: true })
    expect(dry.workspaces).toContain(due.id)
    expect(dry.workspaces).not.toContain(recent.id)
    expect(dry.workspaces).not.toContain(running.id)
    cloud.on = false
    expect(await purgeCanceled(db, { now: NOW })).toMatchObject({ billing: 'off', workspaces: [] })
    for (const ws of [recent, running, due]) expect(await workspaceRow(ws.id)).toBeDefined()
    expect(await auditOf(due.id, 'workspace.purge')).toEqual([])
    cloud.on = true
    expect((await purgeCanceled(db, { now: NOW })).workspaces).toEqual([due.id])
    for (const ws of [recent, running]) expect(await workspaceRow(ws.id)).toBeDefined()
  })

  test('an owner who is a member of another workspace keeps the account; members only here lose theirs', async () => {
    const ws = await createWorkspace('Owner Stays Plumbing')
    const other = await createWorkspace('Owner Elsewhere Plumbing')
    await db.insert(member).values({
      id: rid('mem'),
      organizationId: other.id,
      userId: ws.owner.userId,
      role: 'member',
      createdAt: new Date(),
    })
    const onlyHere = await addMember(ws.id, 'member')
    await canceledBill(ws, 95)
    const result = await purgeCanceled(db, { now: NOW })
    expect(result.workspaces).toContain(ws.id)
    expect(result.accounts).toBe(0)
    expect(await account(ws.owner.userId)).toBeDefined()
    expect(await account(onlyHere.userId)).toBeUndefined()
    expect(await workspaceRow(other.id)).toBeDefined()
  })

  test('a partner bill: its client workspaces go through the delete path (seats follow); the partner owner keeps the account; a released client stays', async () => {
    const first = await createWorkspace('Partner Client One Plumbing')
    const second = await createWorkspace('Partner Client Two Plumbing')
    const released = await createWorkspace('Partner Released Plumbing')
    // The partner's bill, canceled 100 days ago, owned by someone on the partner team (no workspace of their own).
    const billId = await canceledBill(first, 100)
    await db.update(billing_accounts).set({ kind: 'partner' }).where(eq(billing_accounts.id, billId))
    const [partner] = await db
      .insert(partners)
      .values({ id: rid('ptr'), name: 'Pipe Partners', status: 'approved', billing_account_id: billId, created_by: 'cli' })
      .returning()
    await db.insert(partner_members).values({ partner_id: partner!.id, user_id: first.owner.userId, role: 'owner' })
    for (const ws of [first, second])
      await db
        .update(organization)
        .set({ billingAccountId: billId, partnerId: partner!.id, billingState: 'suspended' })
        .where(eq(organization.id, ws.id))
    // Released to a running bill of its own (partners.ts detachClient): no longer on the canceled bill.
    const ownBill = rid('bill')
    await db.insert(billing_accounts).values({ id: ownBill, kind: 'cloud', owner_user_id: released.owner.userId, status: 'active' })
    await db.update(organization).set({ billingAccountId: ownBill, partnerId: null }).where(eq(organization.id, released.id))
    // The partner owner is no member of the client workspaces: the second client's owner has only that one.
    await db.delete(member).where(and(eq(member.organizationId, first.id), eq(member.userId, first.owner.userId)))

    seats.deleted = []
    const result = await purgeCanceled(db, { now: NOW })
    expect(result.workspaces).toEqual(expect.arrayContaining([first.id, second.id]))
    expect(result.workspaces).not.toContain(released.id)
    expect(seats.deleted).toEqual(expect.arrayContaining([first.id, second.id]))
    expect(await workspaceRow(first.id)).toBeUndefined()
    expect(await workspaceRow(second.id)).toBeUndefined()
    expect(await getCall(second.call.id)).toBeUndefined()
    expect(await workspaceRow(released.id)).toBeDefined()
    expect(await getCall(released.call.id)).toBeDefined()
    // On a partner team: the partner area is their place, so the bill owner keeps the account; the partner stays.
    expect(await account(first.owner.userId)).toBeDefined()
    expect(await account(second.owner.userId)).toBeUndefined()
    expect((await db.select().from(partners).where(eq(partners.id, partner!.id)))[0]).toBeDefined()
    expect((await db.select().from(billing_accounts).where(eq(billing_accounts.id, billId)))[0]).toMatchObject({
      status: 'canceled',
    })
  })

  test("seats and extra calls follow a delete on a running partner bill, never on a canceled one (Stripe's subscription ended)", async () => {
    const running = await createWorkspace('Seats Running Plumbing')
    const canceled = await createWorkspace('Seats Canceled Plumbing')
    const runningBill = await canceledBill(running, 10)
    await db
      .update(billing_accounts)
      .set({ kind: 'partner', status: 'active', canceled_at: null, stripe_subscription_id: rid('sub') })
      .where(eq(billing_accounts.id, runningBill))
    const canceledBillId = await canceledBill(canceled, 100)
    await db
      .update(billing_accounts)
      .set({ kind: 'partner', stripe_subscription_id: rid('sub') })
      .where(eq(billing_accounts.id, canceledBillId))
    await db.update(organization).set({ extraCalls: 5 }).where(eq(organization.id, canceled.id))
    const after: (() => Promise<void>)[] = []
    // Without a job queue the seat sync runs after the commit: here it is only collected, never run (no Stripe).
    await db.transaction(tx => seatsFollowDelete(tx, work => after.push(work), running.id))
    expect(after).toHaveLength(1)
    await db.transaction(tx => seatsFollowDelete(tx, work => after.push(work), canceled.id))
    expect(after).toHaveLength(1)
  })
})
