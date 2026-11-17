// Deleting a workspace with all its data: `workspace.delete` (instance admins, docs/architecture.md §12) and
// `workspace.deleteOwn` (its owner, from Workspace settings; workspace-delete-own.ts).
//
// Every table with a `workspace_id` column loses the workspace's rows, found from the schema itself, so a new
// table is covered without a change here; children before the tables they reference (foreign keys). Kept on
// purpose (KEPT_TABLES): the audit log (`commands`, cut down to ids like the 90-day prune; `auth_events`), number
// purchases (the install's purchase limits count them), voice clone consent records (the voices themselves
// are deleted at the provider) and the billing ledger with its sums (a bill spans workspaces; the ledger is
// append-only). The organization row goes last; its members and invitations go with it
// (foreign keys). Members who belong to no other workspace lose their accounts too (sessions, passkeys and
// sign-in methods go with them), unless the admin keeps them (`keepAccounts`); members of other workspaces, instance
// admins and the admin deleting it always keep theirs; an owner deleting their own keeps theirs only when they ask. A kept user's session on the workspace moves to none, so
// its next request lands on the user's next workspace, or the create-workspace page.
//
// Outside the database: recording files are deleted by a job per file queued in this transaction (they go only
// if it commits); the workspace's queued jobs are dropped; cloned voices are deleted at the provider (job). Phone
// numbers: a number Linedesk bought in the install's carrier account is released there (so nobody pays for it);
// any other number is un-routed in the account it is in and stays the business's (its own carrier account, or
// a number it brought). A carrier failure does not stop the delete: the number is listed as left at the carrier.
import type { WorkspaceDeleteData } from '@linedesk/actions'
import * as schema from '@linedesk/db'
import {
  bookings,
  call_events,
  calls,
  commands,
  invitation,
  member,
  organization,
  partner_members,
  phone_numbers,
  session,
  star_prompts,
  type Tx,
  user,
  webhook_deliveries,
} from '@linedesk/db'
import type { TelephonyProvider } from '@linedesk/telephony'
import { and, eq, getTableName, inArray, is, isNotNull, isNull, notInArray, sql } from 'drizzle-orm'
import { alias, getTableConfig, PgTable } from 'drizzle-orm/pg-core'
import { AUDITED_ACTIONS, insertAuthEvent } from './audit.ts'
import { refuseDeletingBillOwners } from './billing-owner.ts'
import { pruneSet } from './command-log.ts'
import { Reject } from './handler-context.ts'
import { isInstanceAdmin } from './instance-admin.ts'
import { queueRecordingFileDeletions } from './jobs.ts'
import { telephonyProvider } from './provider-settings.ts'
import { removeTransferTrunks } from './transfer-trunk.ts'
import { releaseWorkspaceClones } from './voices.ts'
import { lockWorkspaceCarrier, ownCarrierProvider } from './workspace-carrier.ts'

/** Tables with a workspace_id whose rows outlive the workspace, and why. */
export const KEPT_TABLES: Record<string, string> = {
  commands: 'the audit log; cut down to ids',
  auth_events: 'the audit log',
  number_purchases: "the purchase limits of the install's carrier account count them",
  voice_clones: 'the consent records; the voices are deleted at the provider',
  ledger_entries: 'the billing ledger: append-only, the record of what a bill was charged (docs/billing.md)',
  usage_counters: 'sums of the billing ledger, which stays',
}

/** The tables a workspace's rows are deleted from, children first (a table before every table it references). */
export function workspaceTables(): PgTable[] {
  const tables = (Object.values(schema) as unknown[]).filter(
    (value): value is PgTable => is(value, PgTable) && 'workspace_id' in value && !(getTableName(value) in KEPT_TABLES),
  )
  const references = new Map(
    tables.map(table => [
      table,
      new Set(
        getTableConfig(table)
          .foreignKeys.map(fk => fk.reference().foreignTable)
          .filter(t => t !== table),
      ),
    ]),
  )
  const ordered: PgTable[] = []
  let left = [...tables]
  while (left.length) {
    // Next: a table no remaining table references.
    const free = left.filter(table => !left.some(other => other !== table && references.get(other)!.has(table)))
    if (!free.length) throw new Error('workspace tables reference each other in a cycle')
    ordered.push(...free)
    left = left.filter(table => !free.includes(table))
  }
  return ordered
}

/** Drops the workspace's queued jobs (emails, pushes, webhook deliveries, evaluations): what they are about is gone. */
async function dropQueuedJobs(tx: Tx, workspaceId: string) {
  const [queue] = (await tx.execute(sql`select to_regclass('pgboss.job') is not null as present`)).rows as {
    present: boolean
  }[]
  if (!queue?.present) return
  const ids = (column: unknown, table: unknown) =>
    sql`(select ${column}::text from ${table} where workspace_id = ${workspaceId})`
  await tx.execute(sql`
    delete from pgboss.job where state in ('created', 'retry') and (
      data->>'workspaceId' = ${workspaceId}
      or data->>'callId' in ${ids(calls.id, calls)}
      or data->>'bookingId' in ${ids(bookings.id, bookings)}
      or data->>'deliveryId' in ${ids(webhook_deliveries.id, webhook_deliveries)}
      or data->>'eventId' in ${ids(call_events.id, call_events)}
    )`)
}

type PhoneNumberRow = typeof phone_numbers.$inferSelect
type NumberResult = WorkspaceDeleteData['numbers'][number]

/**
 * The carrier accounts the numbers are in, resolved before their credentials (provider_settings rows of the
 * workspace) are deleted. null: the account cannot be reached (not set up any more).
 */
async function carriersFor(tx: Tx, workspaceId: string, numbers: PhoneNumberRow[], telephony?: TelephonyProvider) {
  const resolve = async (get: () => Promise<TelephonyProvider | null>) => {
    if (telephony) return telephony
    try {
      return await get()
    } catch {
      return null
    }
  }
  const atCarrier = numbers.filter(n => n.provider !== 'dev')
  return {
    install: atCarrier.some(n => n.carrier_account === 'install') ? await resolve(() => telephonyProvider(tx)) : null,
    workspace: atCarrier.some(n => n.carrier_account === 'workspace')
      ? await resolve(() => ownCarrierProvider(tx, workspaceId))
      : null,
  }
}

const reason = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 200)

/** What happens to one number at its carrier: see the file comment. Never throws. */
async function releaseAtCarrier(number: PhoneNumberRow, provider: TelephonyProvider | null): Promise<NumberResult> {
  const { e164 } = number
  if (number.provider === 'dev') return { e164, carrier: 'none' }
  const account = number.carrier_account === 'workspace' ? "the workspace's own carrier account" : 'the carrier account'
  if (!provider) return { e164, carrier: 'left', note: `${account} is not set up: release or re-route it there` }
  if (provider.name !== number.provider)
    return {
      e164,
      carrier: 'left',
      note: `it is at ${number.provider}, but ${provider.name} is in use: release or re-route it there`,
    }
  if (!number.provider_ref)
    return { e164, carrier: 'left', note: `no carrier reference: release or re-route it at ${number.provider}` }
  const owned = { e164, providerRef: number.provider_ref }
  const release = number.purchased && number.carrier_account === 'install'
  try {
    await (release ? provider.releaseNumber(owned) : provider.unrouteNumber(owned))
    return { e164, carrier: release ? 'released' : 'unrouted' }
  } catch (e) {
    return { e164, carrier: 'left', note: `${release ? 'releasing' : 'un-routing'} failed (${reason(e)})` }
  }
}

/**
 * The members whose only workspace this is: their accounts go with it. Never someone on a white-label partner's team
 * (the team is their place without a workspace; security review of #1100, M-3). Never an instance admin (the column or
 * INSTANCE_ADMIN_EMAILS: the same `isInstanceAdmin` as everywhere), never `spareUserId` (the admin deleting it; the
 * owner deleting their own when they keep their account; null spares nobody else).
 */
export async function membersOnlyHere(tx: Tx, workspaceId: string, spareUserId: string | null) {
  const result = await tx.execute(sql`
    select u.id, u.email, u.instance_admin, u.email_verified from member m join "user" u on u.id = m.user_id
    where m.organization_id = ${workspaceId} and u.id is distinct from ${spareUserId}
      and not exists (select 1 from member other where other.user_id = m.user_id and other.organization_id <> ${workspaceId})
      and not exists (select 1 from partner_members pm where pm.user_id = m.user_id)
    order by u.email`)
  const rows = result.rows as { id: string; email: string; instance_admin: boolean; email_verified: boolean }[]
  return rows
    .filter(u => !isInstanceAdmin({ email: u.email, emailVerified: u.email_verified, instanceAdmin: u.instance_admin }))
    .map(u => ({ id: u.id, email: u.email }))
}

/**
 * The pending invitations these accounts sent pass to their workspace's owner before the accounts go (they would
 * otherwise go with them, `invitation.inviter_id` on delete cascade, and the invitees' links stop working): Janik,
 * 2026-11-15, LIN-264. One audit line per invitation (`invitation_reassigned`, naming the owner who holds it now).
 * A removal cancels the removed person's invitations in that workspace first (cancelSentInvitations, team.ts), so
 * this moves those of a leave, a workspace delete and invitations in other workspaces. A workspace without another owner
 * (no owner, or the owner is among the accounts) has no one to pass them to: those go with the account, as before.
 */
async function reassignInvitations(tx: Tx, ids: string[]) {
  const owner = alias(member, 'owner')
  const pending = await tx
    .select({
      id: invitation.id,
      workspaceId: invitation.organizationId,
      email: invitation.email,
      senderId: invitation.inviterId,
      ownerId: owner.userId,
    })
    .from(invitation)
    .innerJoin(owner, and(eq(owner.organizationId, invitation.organizationId), eq(owner.role, 'owner')))
    .where(and(inArray(invitation.inviterId, ids), eq(invitation.status, 'pending'), notInArray(owner.userId, ids)))
    .for('update', { of: invitation })
  for (const invite of pending) {
    await tx.update(invitation).set({ inviterId: invite.ownerId }).where(eq(invitation.id, invite.id))
    // Who sent it (user), to whom (method) and who holds it now (subject: the owner), so the log shows the hand-over.
    await insertAuthEvent(tx, {
      event: 'invitation_reassigned',
      userId: invite.senderId,
      method: invite.email,
      workspaceId: invite.workspaceId,
      subjectId: invite.ownerId,
    })
  }
}

/** Deletes these accounts: sessions, sign-in methods and passkeys go with them (on delete cascade); the audit log keeps its ids. */
export async function deleteAccounts(tx: Tx, ids: string[]) {
  if (!ids.length) return
  // The owner of a running bill hands it over or cancels first (docs/billing.md §8).
  await refuseDeletingBillOwners(tx, ids)
  await reassignInvitations(tx, ids)
  await tx.delete(star_prompts).where(inArray(star_prompts.user_id, ids))
  await tx.delete(user).where(inArray(user.id, ids))
}

/**
 * After a member was removed from a workspace: their account goes too when it is in no workspace any more (no account
 * without a workspace unless someone keeps it), except a server admin's, who runs the server without one, and that of
 * someone on a partner team. Whether it went.
 */
export async function deleteAccountWithoutWorkspace(tx: Tx, userId: string): Promise<boolean> {
  const [account] = await tx.select().from(user).where(eq(user.id, userId)).for('update')
  if (!account || isInstanceAdmin(account)) return false
  const [still] = await tx.select({ id: member.id }).from(member).where(eq(member.userId, userId)).limit(1)
  if (still) return false
  // On a white-label partner's team: the partner area is their place without a workspace (security review of #1100, M-3).
  const [onPartnerTeam] = await tx
    .select({ id: partner_members.partner_id })
    .from(partner_members)
    .where(eq(partner_members.user_id, userId))
    .limit(1)
  if (onPartnerTeam) return false
  await deleteAccounts(tx, [userId])
  return true
}

/**
 * Deletes the workspace; `name` must be its name (as typed to confirm, case and outer spaces aside). `spareUserId`
 * keeps that account even when this is its only workspace: the instance admin deleting it (workspace.delete), the
 * owner deleting their own who keeps theirs (workspace.deleteOwn), or null.
 */
export async function deleteWorkspace(
  tx: Tx,
  input: { workspaceId: string; name: string; keepAccounts?: boolean },
  now: string,
  spareUserId: string | null,
  telephony?: TelephonyProvider,
  /** Database work that belongs to the delete (the emails to members), given the deleted accounts' addresses: before the carrier step. */
  beforeCarrier?: (usersDeleted: string[]) => Promise<void>,
): Promise<WorkspaceDeleteData> {
  const { workspaceId } = input
  const [workspace] = await tx.select().from(organization).where(eq(organization.id, workspaceId)).for('update')
  if (!workspace) throw new Reject('workspace not found')
  if (workspace.name.trim().toLowerCase() !== input.name.trim().toLowerCase())
    throw new Reject(`type the workspace's name, ${workspace.name}, to confirm`)
  // No number is set up or released for it meanwhile.
  await lockWorkspaceCarrier(tx, workspaceId)

  const numbers = await tx.select().from(phone_numbers).where(eq(phone_numbers.workspace_id, workspaceId))
  const carriers = await carriersFor(tx, workspaceId, numbers, telephony)
  const recordings = await tx
    .select({ store: calls.recording_store, key: calls.recording_key })
    .from(calls)
    .where(and(eq(calls.workspace_id, workspaceId), isNotNull(calls.recording_key)))
  await queueRecordingFileDeletions(
    tx,
    recordings.map(r => ({ store: r.store, key: r.key! })),
  )
  await releaseWorkspaceClones(tx, workspaceId)
  await dropQueuedJobs(tx, workspaceId)
  // The audit log stays; everything else the log kept of this workspace's commands goes down to ids.
  await tx
    .update(commands)
    .set(pruneSet(new Date(now)))
    .where(
      and(
        eq(commands.workspace_id, workspaceId),
        isNull(commands.pruned_at),
        notInArray(commands.action, Object.keys(AUDITED_ACTIONS)),
      ),
    )
  await tx.update(session).set({ activeOrganizationId: null }).where(eq(session.activeOrganizationId, workspaceId))

  const deleted: Record<string, number> = {}
  for (const table of workspaceTables()) {
    const column = (table as unknown as { workspace_id: typeof calls.workspace_id }).workspace_id
    const rows = (await tx.execute(sql`delete from ${table} where ${column} = ${workspaceId}`)).rowCount ?? 0
    if (rows) deleted[getTableName(table)] = rows
  }
  const users = input.keepAccounts ? [] : await membersOnlyHere(tx, workspaceId, spareUserId)
  // Members and invitations go with it (on delete cascade).
  await tx.delete(organization).where(eq(organization.id, workspaceId))
  await deleteAccounts(
    tx,
    users.map(u => u.id),
  )
  await beforeCarrier?.(users.map(u => u.email))

  // Last, so a database failure above never leaves a number released for a workspace that is still there.
  const numberResults: NumberResult[] = []
  for (const number of numbers)
    numberResults.push(
      await releaseAtCarrier(number, number.carrier_account === 'workspace' ? carriers.workspace : carriers.install),
    )
  // The LiveKit trunk transfers dialled out through, for the workspace's own carrier account.
  await removeTransferTrunks(workspaceId).catch(e =>
    console.warn(`transfer trunks of deleted workspace ${workspaceId} not removed: ${reason(e)}`),
  )
  return {
    workspaceId,
    name: workspace.name,
    deleted,
    recordings: recordings.length,
    usersDeleted: users.map(u => u.email),
    numbers: numberResults,
  }
}
