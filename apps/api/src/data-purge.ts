// Erasing what the privacy text promises to erase (legal research A7 and A8, LIN-419). Two daily jobs (jobs.ts):
//
// - `data.purgeDeleted` (A7): a call deleted in the inbox (`calls.deleted_at`, call.delete) can be restored for
//   DELETED_RESTORE_DAYS; after that it is erased for good. Its recording file goes first (from the store it is in),
//   then the row; its transcript, activity, evaluation, reply timings, app pushes and billing reservation go with it
//   (on delete cascade), its unanswered knowledge questions too. A booking made on the call stays (it is the
//   calendar's), without the link. A contact deleted the same way (`contacts.deleted_at`, contact.delete) is erased
//   too; its remaining calls and bookings lose the link. A merged contact (`merged_into`) is not a deletion but the
//   forwarding of its number to the contact it was merged into: it goes only once that contact is gone. The command
//   log and webhook payloads about the call or contact were already cut down when it was deleted (handlers.ts).
// - `data.purgeCanceled` (A8): 90 days after a bill was canceled (DUNNING.dataDays; the subscription ended at the end
//   of its period after billing.cancel, was deleted in Stripe, or dunning canceled it on day 30: `canceled_at` is that
//   moment, the date the cancellation email named as `dataUntil`), every workspace still on it is deleted with all its
//   data through deleteWorkspace (workspace-delete.ts), and the bill owner's account when it is left in no workspace.
//   What accounting needs stays: the bill (`billing_accounts`), its invoices, periods, recharges, refunds, disputes
//   and alerts, and the ledger with its sums (KEPT_TABLES); none of them holds a call or a caller. Runs only while
//   billing is in effect: with billing off nothing is canceled and the workspaces work as before.
//
// Both are idempotent (each run looks again at what is due, and checks it again under a lock before deleting),
// batched (a backlog is worked off over the next days), logged, and write one audit entry (a `commands` row by
// PURGE_ACTOR) per workspace and run. DATA_PURGE_DRY_RUN=true makes both only report what they would delete.
import {
  billing_accounts,
  bookings,
  calls,
  commands,
  contacts,
  knowledge_questions,
  organization,
  provider_failures,
  type Tx,
} from '@linedesk/db'
import { and, asc, eq, inArray, isNotNull, isNull, lt, lte, ne, or, sql } from 'drizzle-orm'
import { alertInstanceAdmins } from './admin-alerts.ts'
import { DUNNING } from './billing-lifecycle.ts'
import { billingState } from './billing-settings.ts'
import { dataPurgeFailedAlert } from './emails/alerts.ts'
import { Reject } from './handler-context.ts'
import { queueRecordingFileDeletions } from './jobs.ts'
import { lockBalance } from './ledger.ts'
import { seatsFollowDelete } from './partner-billing.ts'
import type { StoreFor } from './recording-retention.ts'
import { deleteAccountWithoutWorkspace, deleteWorkspace } from './workspace-delete.ts'

type Env = Record<string, string | undefined>

/** How long a deleted call or contact can be restored before it is erased (the privacy text: "for 30 days"). */
export const DELETED_RESTORE_DAYS = 30
/** Calls and contacts erased per run, each; a backlog goes over the next days. */
const PURGE_BATCH = 500
/** Workspaces deleted per run: each is one transaction with every table of the workspace. */
const WORKSPACE_BATCH = 20
/** Who the audit entries name: the jobs themselves, which no person, role or key is. */
export const PURGE_ACTOR = 'retention:system'
/** The audit entries (AUDITED_ACTIONS): one per workspace and run. */
export const PURGE_DELETED_ACTION = 'data.purgeDeleted'
export const PURGE_CANCELED_ACTION = 'workspace.purge'

const DAY_MS = 86_400_000
const daysBefore = (at: string, days: number) => new Date(Date.parse(at) - days * DAY_MS).toISOString()
const reason = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 200)

/** DATA_PURGE_DRY_RUN=true: the jobs only report (log and job result) what they would delete. */
export const purgeDryRun = (env: Env = process.env) => env.DATA_PURGE_DRY_RUN === 'true'

async function recordPurge(tx: Tx, workspaceId: string, action: string, input: object, data: object) {
  await tx.insert(commands).values({
    id: `cmd_${crypto.randomUUID().replaceAll('-', '')}`,
    workspace_id: workspaceId,
    actor_id: PURGE_ACTOR,
    action,
    input,
    result: { ok: true, rows: {}, data },
  })
}

// ---- A7: deleted calls and contacts ----

export type DeletedPurgeResult = {
  dryRun: boolean
  /** Erased (in a dry run: due). */
  calls: string[]
  contacts: string[]
  recordings: number
  /** Calls kept for the next run: their recording could not be deleted. */
  failed: string[]
}

const callDue = (cutoff: string) =>
  and(isNotNull(calls.deleted_at), lt(calls.deleted_at, cutoff), ne(calls.status, 'live'))

/** A deleted contact past the cutoff; a merged one only once the contact it was merged into is gone. */
function contactDue(cutoff: string) {
  return and(
    isNotNull(contacts.deleted_at),
    lt(contacts.deleted_at, cutoff),
    or(
      isNull(contacts.merged_into),
      sql`not exists (select 1 from ${contacts} as merge_target where merge_target.id = ${contacts.merged_into})`,
    ),
  )
}

/** Ids grouped by workspace, in the order found. */
function byWorkspace(rows: { id: string; workspaceId: string }[]) {
  const groups = new Map<string, string[]>()
  for (const { id, workspaceId } of rows) groups.set(workspaceId, [...(groups.get(workspaceId) ?? []), id])
  return groups
}

/**
 * The call rows go, with what hangs on them: transcript, activity, evaluation, reply timings, app pushes and billing
 * reservation (on delete cascade), and the unanswered knowledge questions. The recording file is the caller's to delete.
 */
async function eraseCallRows(tx: Tx, ids: string[]) {
  // What the caller asked that nobody acted on goes with the call; an answered question became an FAQ and stays.
  await tx
    .delete(knowledge_questions)
    .where(and(inArray(knowledge_questions.call_id, ids), ne(knowledge_questions.status, 'answered')))
  // The install's provider failure record names the latest call it happened on, without a foreign key.
  await tx.update(provider_failures).set({ call_id: null }).where(inArray(provider_failures.call_id, ids))
  await tx.delete(calls).where(inArray(calls.id, ids))
}

/** The audit entry of a call erased at once (call.delete with `permanent`), by the person who did it. */
export const ERASE_NOW_ACTION = 'call.erase'

/**
 * "Delete permanently now" (decision of 2026-11-17): call.delete with `permanent` erases the call of this workspace at once
 * instead of after DELETED_RESTORE_DAYS, exactly as the daily purge does (eraseCallRows); its recording file is
 * deleted from its store after the commit (the recording.fileDelete job, retried). The caller checks the permission
 * (call:erase, owners and admins). A live call is refused: the assistant is still writing to it. One audit entry,
 * by `actorId`, that the audit log keeps (AUDITED_ACTIONS).
 */
export async function eraseCallNow(tx: Tx, workspaceId: string, callId: string, actorId: string) {
  const [call] = await tx
    .select({ id: calls.id, key: calls.recording_key, store: calls.recording_store, status: calls.status })
    .from(calls)
    .where(and(eq(calls.id, callId), eq(calls.workspace_id, workspaceId)))
    .for('update')
  if (!call) throw Reject.t('server.api.callNotFound')
  if (call.status === 'live') throw Reject.t('server.api.eraseLiveCall')
  if (call.key) await queueRecordingFileDeletions(tx, [{ store: call.store, key: call.key }])
  await eraseCallRows(tx, [call.id])
  await tx.insert(commands).values({
    id: `cmd_${crypto.randomUUID().replaceAll('-', '')}`,
    workspace_id: workspaceId,
    actor_id: actorId,
    action: ERASE_NOW_ACTION,
    input: { calls: 1, recordings: call.key ? 1 : 0 },
    result: { ok: true, rows: {}, data: { callIds: [call.id] } },
  })
}

/** One workspace's due calls and contacts, locked and checked again, erased; one audit entry. */
async function purgeWorkspaceDeleted(
  tx: Tx,
  workspaceId: string,
  ids: { calls: string[]; contacts: string[] },
  cutoff: string,
  storeFor: StoreFor,
  result: DeletedPurgeResult,
) {
  // Locked, so a restore in the meantime waits and then finds nothing; one being restored right now is skipped.
  const due = ids.calls.length
    ? await tx
        .select({ id: calls.id, key: calls.recording_key, store: calls.recording_store })
        .from(calls)
        .where(and(inArray(calls.id, ids.calls), eq(calls.workspace_id, workspaceId), callDue(cutoff)))
        .for('update', { skipLocked: true })
    : []
  const goneCalls: string[] = []
  let recordings = 0
  for (const call of due) {
    if (call.key) {
      try {
        // A file that is already gone counts as deleted (RecordingStore.delete).
        await (await storeFor(call.store)).delete(call.key)
        recordings++
      } catch (e) {
        console.warn(
          `data purge: the recording of call ${call.id} could not be deleted, kept for the next run: ${reason(e)}`,
        )
        result.failed.push(call.id)
        continue
      }
    }
    goneCalls.push(call.id)
  }
  const goneContacts = ids.contacts.length
    ? (
        await tx
          .select({ id: contacts.id })
          .from(contacts)
          .where(and(inArray(contacts.id, ids.contacts), eq(contacts.workspace_id, workspaceId), contactDue(cutoff)))
          .for('update', { skipLocked: true })
      ).map(c => c.id)
    : []
  if (!goneCalls.length && !goneContacts.length) return

  if (goneCalls.length) await eraseCallRows(tx, goneCalls)
  if (goneContacts.length) {
    await tx.update(calls).set({ contact_id: null }).where(inArray(calls.contact_id, goneContacts))
    await tx.update(bookings).set({ contact_id: null }).where(inArray(bookings.contact_id, goneContacts))
    await tx.delete(contacts).where(inArray(contacts.id, goneContacts))
  }
  await recordPurge(
    tx,
    workspaceId,
    PURGE_DELETED_ACTION,
    { calls: goneCalls.length, contacts: goneContacts.length, recordings, days: DELETED_RESTORE_DAYS },
    { callIds: goneCalls, contactIds: goneContacts },
  )
  result.calls.push(...goneCalls)
  result.contacts.push(...goneContacts)
  result.recordings += recordings
}

/**
 * The daily A7 job: calls and contacts deleted more than DELETED_RESTORE_DAYS ago are erased (see the file comment).
 * One transaction per workspace; a recording the store refuses keeps its call for the next run.
 */
export async function purgeDeleted(
  db: Tx,
  storeFor: StoreFor,
  { now = new Date().toISOString(), dryRun = false, limit = PURGE_BATCH } = {},
): Promise<DeletedPurgeResult> {
  const cutoff = daysBefore(now, DELETED_RESTORE_DAYS)
  const result: DeletedPurgeResult = { dryRun, calls: [], contacts: [], recordings: 0, failed: [] }
  const dueCalls = await db
    .select({ id: calls.id, workspaceId: calls.workspace_id, key: calls.recording_key })
    .from(calls)
    .where(callDue(cutoff))
    .orderBy(asc(calls.deleted_at))
    .limit(limit)
  const dueContacts = await db
    .select({ id: contacts.id, workspaceId: contacts.workspace_id })
    .from(contacts)
    .where(contactDue(cutoff))
    .orderBy(asc(contacts.deleted_at))
    .limit(limit)
  if (dryRun) {
    result.calls = dueCalls.map(c => c.id)
    result.contacts = dueContacts.map(c => c.id)
    result.recordings = dueCalls.filter(c => c.key).length
    return result
  }
  const callsOf = byWorkspace(dueCalls)
  const contactsOf = byWorkspace(dueContacts)
  for (const workspaceId of new Set([...callsOf.keys(), ...contactsOf.keys()])) {
    const ids = { calls: callsOf.get(workspaceId) ?? [], contacts: contactsOf.get(workspaceId) ?? [] }
    try {
      await db.transaction(tx => purgeWorkspaceDeleted(tx, workspaceId, ids, cutoff, storeFor, result))
    } catch (e) {
      console.error(`data purge: workspace ${workspaceId} failed, tried again on the next run:`, e)
      result.failed.push(...ids.calls)
    }
  }
  return result
}

// ---- A8: workspaces 90 days after their bill was canceled ----

export type CanceledPurgeResult = {
  billing: 'on' | 'off'
  dryRun: boolean
  /** Deleted (in a dry run: due), by id. */
  workspaces: string[]
  /** Bill owners' accounts deleted with their last workspace. */
  accounts: number
  /** `<workspace id>: <reason>`; the next run tries again. */
  failed: string[]
}

/** Workspaces on a bill canceled at or before `cutoff`, oldest cancellation first. */
function canceledWorkspaces(db: Tx, cutoff: string, limit: number) {
  return db
    .select({
      id: organization.id,
      name: organization.name,
      billId: billing_accounts.id,
      canceledAt: billing_accounts.canceled_at,
    })
    .from(organization)
    .innerJoin(billing_accounts, eq(billing_accounts.id, organization.billingAccountId))
    .where(and(eq(billing_accounts.status, 'canceled'), lte(billing_accounts.canceled_at, cutoff)))
    .orderBy(asc(billing_accounts.canceled_at), asc(organization.id))
    .limit(limit)
}

/**
 * The bill owner's account goes once it is in no workspace (deleteAccountWithoutWorkspace: never an instance admin's,
 * never that of someone on a white-label partner's team), unless it still owns a running bill (deleteAccounts would
 * refuse it). The bill keeps the owner's id (no foreign key).
 */
async function deleteOwnerIfIdle(tx: Tx, userId: string): Promise<boolean> {
  const [running] = await tx
    .select({ id: billing_accounts.id })
    .from(billing_accounts)
    .where(
      and(
        eq(billing_accounts.owner_user_id, userId),
        inArray(billing_accounts.status, ['trialing', 'active', 'past_due']),
      ),
    )
    .limit(1)
  if (running) return false
  return deleteAccountWithoutWorkspace(tx, userId)
}

/** One workspace, checked again under the bill's lock (ledger.ts lock order: the balance row first); null: not due. */
async function purgeCanceledWorkspace(
  tx: Tx,
  workspace: { id: string; billId: string },
  cutoff: string,
  now: string,
  onCommit: (work: () => Promise<void>) => void,
): Promise<{ account: boolean } | null> {
  await lockBalance(tx, workspace.billId)
  const [bill] = await tx.select().from(billing_accounts).where(eq(billing_accounts.id, workspace.billId)).for('update')
  if (bill?.status !== 'canceled' || !bill.canceled_at || Date.parse(bill.canceled_at) > Date.parse(cutoff)) return null
  const [current] = await tx
    .select({ name: organization.name, billId: organization.billingAccountId })
    .from(organization)
    .where(eq(organization.id, workspace.id))
    .for('update')
  // Moved to another bill meanwhile (Server admin › Billing), or gone.
  if (current?.billId !== bill.id) return null
  // The same delete path as Delete workspace: a partner's client leaves its seat, extra calls leave the bill's item
  // (partner-billing.ts; for a canceled subscription there is nothing left to lower in Stripe, so that is a no-op).
  await seatsFollowDelete(tx, onCommit, workspace.id)
  // The owner is decided on below, so an owner who is a member elsewhere keeps their account.
  const deleted = await deleteWorkspace(tx, { workspaceId: workspace.id, name: current.name }, now, bill.owner_user_id)
  const account = await deleteOwnerIfIdle(tx, bill.owner_user_id)
  await recordPurge(
    tx,
    workspace.id,
    PURGE_CANCELED_ACTION,
    {
      workspaceId: workspace.id,
      name: current.name,
      billId: bill.id,
      canceledAt: bill.canceled_at,
      days: DUNNING.dataDays,
    },
    { ...deleted, ownerAccountDeleted: account },
  )
  return { account }
}

/**
 * The daily A8 job: every workspace of a bill canceled DUNNING.dataDays (90) or more days ago is deleted (see the file
 * comment). One transaction per workspace; a failure is reported to the instance admins and tried again next run.
 */
export async function purgeCanceled(
  db: Tx,
  { now = new Date().toISOString(), dryRun = false, limit = WORKSPACE_BATCH } = {},
): Promise<CanceledPurgeResult> {
  const result: CanceledPurgeResult = { billing: 'on', dryRun, workspaces: [], accounts: 0, failed: [] }
  if ((await billingState(db)).inEffect === 'none') return { ...result, billing: 'off' }
  const cutoff = daysBefore(now, DUNNING.dataDays)
  const due = await canceledWorkspaces(db, cutoff, limit)
  if (dryRun) return { ...result, workspaces: due.map(w => w.id) }
  for (const workspace of due) {
    try {
      const afterCommit: (() => Promise<void>)[] = []
      const done = await db.transaction(tx =>
        purgeCanceledWorkspace(tx, workspace, cutoff, now, work => afterCommit.push(work)),
      )
      // What follows the commit (the seats without a job queue, the extra-calls item): its own failures alert the
      // admins (partner-billing.ts); the workspace is deleted either way.
      for (const work of afterCommit)
        await work().catch(e => console.error(`data purge: billing follow-up of workspace ${workspace.id} failed:`, e))
      if (!done) continue
      result.workspaces.push(workspace.id)
      if (done.account) result.accounts++
    } catch (e) {
      console.error(`data purge: workspace ${workspace.id} of canceled bill ${workspace.billId} not deleted:`, e)
      result.failed.push(`${workspace.id}: ${reason(e)}`)
    }
  }
  return result
}

/** Runs one job and logs what it did; failures go to the instance admins (the jobs are never retried: the next day is). */
export async function runPurge<T extends { dryRun: boolean; failed: string[] }>(
  job: string,
  run: () => Promise<T>,
  summary: (result: T) => string,
): Promise<T> {
  const result = await run()
  console.log(`${job}${result.dryRun ? ' (dry run, nothing deleted)' : ''}: ${summary(result)}`)
  if (result.failed.length && !result.dryRun)
    await alertInstanceAdmins(dataPurgeFailedAlert(job, result.failed)).catch(e =>
      console.error(`${job}: the alert could not be sent:`, e),
    )
  return result
}
