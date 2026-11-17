// What the bill owner sees and decides about the bill's life (docs/billing.md §3.4, §8; PR 11), and the ownership
// rules the rest of the app keeps:
//
// - `billing.state`: the banner's data (status, why suspended, the dunning and cancellation dates, unpaid numbers, a
//   recharge to confirm, a low balance nothing lifts), for the bill owner only; anyone else gets null.
// - `billing.portOutInfo`: the port-out PIN of each number bought through Linedesk, made on first view and stored
//   encrypted (SECRETS_KEY); the bill owner only, in the app (no impersonation, API key or setup link), with the owner
//   step-up; never kept in the command log. `billing.recordPortOut` (instance admin) checks a request's PIN and emails
//   the bill owner and the workspace owner. Moving the number at the carrier is not automated (see docs/billing.md).
// - `billing.handOver` (the bill owner, with the step-up) and #919's `billing.transferOwner` (an instance admin) name a new
//   bill owner: a member of one of the bill's workspaces with a confirmed address.
// - `team.transferOwnership` of the only workspace on its bill moves the bill with it; with several it is refused
//   until the bill has another owner (billOnWorkspaceHandOver). Deleting the account of a bill owner is refused while
//   the bill runs (refuseDeletingBillOwners).

import { randomInt, timingSafeEqual } from 'node:crypto'
import type {
  BillingOwnerData,
  BillingPortOutData,
  BillingRecordPortOutData,
  BillingStateData,
} from '@linedesk/actions'
import { billing_accounts, billing_numbers, member, organization, phone_numbers, type Tx, user } from '@linedesk/db'
import { and, count, eq, inArray, isNotNull } from 'drizzle-orm'
import { lifecycleDates } from './billing-lifecycle.ts'
import { balanceFlags } from './billing-page.ts'
import { queueLifecycleEmail, UNPAID_RELEASE_DAYS } from './billing-periods.ts'
import type { Actor } from './context.ts'
import type { db } from './db.ts'
import { Forbidden, type Handler, type HandlerCtx, Reject } from './handler-context.ts'
import { lockBalance } from './ledger.ts'
import { ownerStepUpNeeded } from './owner-step-up.ts'
import { decryptSecret, encryptSecret } from './secrets.ts'
import { billPayerChanged, lockForPayerChange, refuseBillingActor } from './usage-levels.ts'

type Bill = typeof billing_accounts.$inferSelect
type Reader = Tx | typeof db

/** Bill statuses during which the owner's account cannot be deleted (docs/billing.md §8). */
const RUNNING: readonly Bill['status'][] = ['trialing', 'active', 'past_due']

const DAY_MS = 86_400_000
/** The AAD slot of a number's port-out PIN (rotate-secrets-key.ts re-encrypts under it). */
export const portOutSlot = (numberId: string) => `port_out:${numberId}`

/** The bill of the actor's workspace, or null (an unbilled workspace). */
async function billOfWorkspace(tx: Reader, workspaceId: string | null) {
  if (!workspaceId) return null
  const [row] = await tx
    .select({ bill: billing_accounts })
    .from(organization)
    .innerJoin(billing_accounts, eq(billing_accounts.id, organization.billingAccountId))
    .where(eq(organization.id, workspaceId))
  return row?.bill ?? null
}

const NOT_BILL_OWNER = 'only the owner of the bill can do this'

/** The actor's bill when they are its owner; refused otherwise (the workspace owner is not always the bill owner). */
async function ownBill(tx: Reader, actor: Actor) {
  const bill = await billOfWorkspace(tx, actor.workspaceId)
  if (!bill) throw new Reject('this workspace has no bill')
  if (bill.owner_user_id !== actor.actorId) throw new Forbidden(NOT_BILL_OWNER)
  return bill
}

/**
 * A choice that makes the bill pay more (Allow Premium, Allow Ultra on; docs/billing.md §7, §8): when the actor's
 * workspace is on a bill, only the bill's owner makes it, not a workspace owner whose workspace another person pays
 * for (security review LIN-396, T1). A workspace without a bill (self-hosted, not billed yet) is not refused here.
 */
export async function refuseUnlessBillOwner(tx: Tx, actor: Actor) {
  if (!actor.workspaceId) return
  // Locked (shared) until the switch is saved (LIN-438): a move to another bill or a new bill owner waits for it and
  // then switches it off again, or it waits for them and sees the new owner. The bill first, then the workspace: the
  // order of every bill status change (bill, then its workspaces' rows), so the two never deadlock. Two statements,
  // never one join: a join waiting on a workspace a move just changed re-checks it against the old bill row, finds
  // none and would read "no bill" (independent review of #1050).
  const [seen] = await tx
    .select({ bill: organization.billingAccountId })
    .from(organization)
    .where(eq(organization.id, actor.workspaceId))
  const [bill] = seen?.bill
    ? await tx
        .select({ owner: billing_accounts.owner_user_id })
        .from(billing_accounts)
        .where(eq(billing_accounts.id, seen.bill))
        .for('share')
    : []
  const [workspace] = await tx
    .select({ bill: organization.billingAccountId })
    .from(organization)
    .where(eq(organization.id, actor.workspaceId))
    .for('share')
  // Moved to another bill meanwhile (a move waits on neither lock taken before it): refused, the owner tries again.
  if ((workspace?.bill ?? null) !== (seen?.bill ?? null)) throw new Forbidden(NOT_BILL_OWNER)
  if (!workspace?.bill) return
  // A bill id without its bill is refused, never read as "no bill".
  if (!bill || bill.owner !== actor.actorId) throw new Forbidden(NOT_BILL_OWNER)
}

/** `billing.state`: the banner's data, for the bill owner only. */
async function billingState({
  tx,
  actor,
  now,
}: HandlerCtx): Promise<{ rows: Record<string, never>; data: BillingStateData }> {
  const bill = await billOfWorkspace(tx, actor.workspaceId)
  if (!bill || bill.owner_user_id !== actor.actorId) return { rows: {}, data: { bill: null } }
  // Through the number's workspace and the bill it is on now, never the row's bill: a workspace moved to another bill
  // takes its numbers with it (security review of #879, L3).
  const unpaid = await tx
    .select({ e164: phone_numbers.e164, since: billing_numbers.unpaid_since })
    .from(billing_numbers)
    .innerJoin(phone_numbers, eq(phone_numbers.id, billing_numbers.phone_number_id))
    .innerJoin(organization, eq(organization.id, phone_numbers.workspace_id))
    .where(and(eq(organization.billingAccountId, bill.id), isNotNull(billing_numbers.unpaid_since)))
  return {
    rows: {},
    data: {
      bill: {
        status: bill.status,
        suspendedReason: bill.status === 'suspended' ? bill.suspend_reason : null,
        pastDueSince: bill.past_due_since,
        ...lifecycleDates(bill),
        canceledAt: bill.status === 'canceled' ? bill.canceled_at : null,
        rechargeFailed: !!bill.recharge_failed_at,
        heldForReview: !!bill.held_for_review_at,
        ...(await balanceFlags(tx, bill, now)),
        unpaidNumbers: unpaid.map(n => ({
          e164: n.e164,
          releaseAt: new Date(Date.parse(n.since!) + UNPAID_RELEASE_DAYS * DAY_MS).toISOString(),
        })),
      },
    },
  }
}

/** The numbers of a bill's workspaces bought on Linedesk's carrier account: the ones Linedesk can port out. */
async function portableNumbers(tx: Reader, billId: string) {
  return tx
    .select({ id: phone_numbers.id, e164: phone_numbers.e164 })
    .from(phone_numbers)
    .innerJoin(organization, eq(organization.id, phone_numbers.workspace_id))
    .where(
      and(
        eq(organization.billingAccountId, billId),
        eq(phone_numbers.purchased, true),
        eq(phone_numbers.carrier_account, 'install'),
      ),
    )
    .orderBy(phone_numbers.e164)
}

/** An 8-digit PIN. */
const newPin = () => String(randomInt(0, 100_000_000)).padStart(8, '0')

/** `billing.portOutInfo`: the bill owner, in the app, with the step-up; each number's PIN made on first view. */
async function portOutInfo({
  tx,
  actor,
  now,
}: HandlerCtx): Promise<{ rows: Record<string, never>; data: BillingPortOutData }> {
  refuseBillingActor(actor)
  const bill = await ownBill(tx, actor)
  const stepUp = await ownerStepUpNeeded(tx, actor)
  if (stepUp) return { rows: {}, data: { stepUp, numbers: [] } }
  const numbers: BillingPortOutData['numbers'] = []
  for (const number of await portableNumbers(tx, bill.id)) {
    await tx
      .insert(billing_numbers)
      .values({
        phone_number_id: number.id,
        billing_account_id: bill.id,
        port_out_code: encryptSecret(newPin(), portOutSlot(number.id)),
      })
      .onConflictDoNothing()
    const [row] = await tx
      .select()
      .from(billing_numbers)
      .where(eq(billing_numbers.phone_number_id, number.id))
      .for('update')
    let stored = row!.port_out_code
    if (!stored || row!.billing_account_id !== bill.id) {
      // A number moved to this bill, or never shown: its own PIN for this bill.
      stored = encryptSecret(newPin(), portOutSlot(number.id))
      await tx
        .update(billing_numbers)
        .set({ port_out_code: stored, billing_account_id: bill.id, updated_at: now })
        .where(eq(billing_numbers.phone_number_id, number.id))
    }
    numbers.push({
      phoneNumberId: number.id,
      e164: number.e164,
      accountNumber: bill.id,
      pin: decryptSecret(stored, portOutSlot(number.id)),
    })
  }
  return { rows: {}, data: { stepUp: null, numbers } }
}

const samePin = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))

/** `billing.recordPortOut` (instance admin): checks the request's PIN and emails the bill and workspace owners. */
async function recordPortOut(
  { tx }: HandlerCtx,
  input: { phoneNumberId: string; pin?: string },
): Promise<{ rows: Record<string, never>; data: BillingRecordPortOutData }> {
  const [number] = await tx.select().from(phone_numbers).where(eq(phone_numbers.id, input.phoneNumberId))
  if (!number) throw new Reject('phone number not found')
  const bill = await billOfWorkspace(tx, number.workspace_id)
  if (!bill) throw new Reject('this number is not on a bill')
  const [row] = await tx.select().from(billing_numbers).where(eq(billing_numbers.phone_number_id, number.id))
  const pinMatches =
    input.pin === undefined || !row?.port_out_code || row.billing_account_id !== bill.id
      ? null
      : samePin(input.pin.trim(), decryptSecret(row.port_out_code, portOutSlot(number.id)))
  await queueLifecycleEmail(tx, bill.id, { kind: 'port_out_requested', e164: number.e164 }, number.workspace_id)
  return { rows: {}, data: { e164: number.e164, billId: bill.id, pinMatches } }
}

/** The ids of the workspaces on a bill. */
export async function workspacesOnBill(tx: Tx, billId: string) {
  const rows = await tx
    .select({ id: organization.id })
    .from(organization)
    .where(eq(organization.billingAccountId, billId))
  return rows.map(r => r.id)
}

/**
 * Makes `userId` the bill's owner: a member of one of its workspaces, with a confirmed address and an account that is
 * not disabled. Under the bill's lock order (its balance row first). Allow Premium and Allow Ultra go off on every
 * workspace of the bill (billPayerChanged, LIN-438), with versions of the assistants by `by`; returns those
 * assistants as they are now.
 */
async function transferBill(tx: Tx, billId: string, userId: string, by: string, now: string) {
  await lockForPayerChange(tx, await workspacesOnBill(tx, billId))
  await lockBalance(tx, billId)
  const [bill] = await tx.select().from(billing_accounts).where(eq(billing_accounts.id, billId)).for('update')
  if (!bill) throw new Reject('bill not found')
  if (bill.owner_user_id === userId) throw new Reject('this person owns the bill already')
  const [membership] = await tx
    .select({ id: member.id })
    .from(member)
    .innerJoin(organization, eq(organization.id, member.organizationId))
    .where(and(eq(member.userId, userId), eq(organization.billingAccountId, billId)))
    .limit(1)
  if (!membership) throw new Reject('the new owner must be a member of one of the workspaces on this bill')
  const [account] = await tx
    .select({ email: user.email, emailVerified: user.emailVerified, disabledAt: user.disabledAt })
    .from(user)
    .where(eq(user.id, userId))
  if (!account || account.disabledAt) throw new Reject('this account is disabled')
  if (!account.emailVerified)
    throw new Reject(`${account.email} must confirm their email address before they can own the bill`)
  await tx
    .update(billing_accounts)
    .set({ owner_user_id: userId, updated_at: now })
    .where(eq(billing_accounts.id, billId))
  const { reset, rows } = await billPayerChanged(tx, await workspacesOnBill(tx, billId), by)
  const data: BillingOwnerData = {
    billId,
    ownerUserId: userId,
    previousOwnerUserId: bill.owner_user_id,
    payerReset: reset,
  }
  return { data, rows }
}

/** The refusal of a bill hand-over without the owner step-up (billing.handOver, and team.transferOwnership moving it). */
const HAND_OVER_STEP_UP = 'confirm it is you (sign in again, or with your passkey) before handing over the bill'

export const billingOwnerHandlers: Record<string, Handler> = {
  'billing.state': billingState,
  'billing.portOutInfo': portOutInfo,
  'billing.recordPortOut': recordPortOut,

  'billing.handOver': async ({ tx, actor, now }: HandlerCtx, input: { userId: string }) => {
    refuseBillingActor(actor)
    const bill = await ownBill(tx, actor)
    if (await ownerStepUpNeeded(tx, actor)) throw new Forbidden(HAND_OVER_STEP_UP)
    const { data, rows } = await transferBill(tx, bill.id, input.userId, actor.actorId, now)
    // Only the rows of the actor's own workspace go back to the app; the other workspaces read theirs when opened.
    const own = rows.filter(a => a.workspace_id === actor.workspaceId)
    return { rows: own.length ? { assistants: own } : {}, data }
  },
}

/**
 * `team.transferOwnership` (docs/billing.md §8, security review of #849, M3): when the owner handing the workspace over
 * owns its bill, the bill moves with it if this is the bill's only workspace; with several, the hand-over is refused
 * until the bill has another owner (billing.handOver). Moving the bill hands over its Stripe customer and saved card,
 * so it needs the same owner step-up as billing.handOver (security review of #920, M6): a session left open cannot
 * move the bill through the workspace instead. Call before the roles change, in the same transaction. A moved bill
 * gets Allow Premium and Allow Ultra off (billPayerChanged, LIN-438); returns what that changed, or null.
 */
export async function billOnWorkspaceHandOver(
  tx: Tx,
  actor: Actor,
  workspaceId: string,
  fromUserId: string,
  toUserId: string,
  now: string,
) {
  const bill = await billOfWorkspace(tx, workspaceId)
  if (!bill || bill.owner_user_id !== fromUserId) return null
  const refuseSeveral = async () => {
    const [workspaces] = await tx
      .select({ n: count() })
      .from(organization)
      .where(eq(organization.billingAccountId, bill.id))
    if ((workspaces?.n ?? 0) > 1)
      throw new Reject(
        'you pay for several workspaces on one bill: hand the bill to someone else first (Settings › Billing), then the workspace',
      )
  }
  await refuseSeveral()
  if (await ownerStepUpNeeded(tx, actor)) throw new Forbidden(HAND_OVER_STEP_UP)
  await lockForPayerChange(tx, [workspaceId])
  await lockBalance(tx, bill.id)
  // Again under the balance lock (independent review of #1050): a workspace moved onto the bill meanwhile (a move
  // takes this lock too) would stay on it under the new owner, with its own Allow Premium and Allow Ultra.
  await refuseSeveral()
  const [moved] = await tx
    .update(billing_accounts)
    .set({ owner_user_id: toUserId, updated_at: now })
    .where(and(eq(billing_accounts.id, bill.id), eq(billing_accounts.owner_user_id, fromUserId)))
    .returning({ id: billing_accounts.id })
  if (!moved) return null
  // The new owner did not choose Allow Premium or Allow Ultra (LIN-438).
  return billPayerChanged(tx, [workspaceId], actor.actorId)
}

/**
 * Deleting accounts (team.leave with deleteAccount, a workspace delete, the account sweep): refused for the owner of a
 * bill that is trialing, active or past_due (docs/billing.md §8): hand the bill over or cancel it first.
 */
export async function refuseDeletingBillOwners(tx: Tx, userIds: string[]) {
  if (!userIds.length) return
  const [running] = await tx
    .select({ id: billing_accounts.id })
    .from(billing_accounts)
    .where(and(inArray(billing_accounts.owner_user_id, userIds), inArray(billing_accounts.status, [...RUNNING])))
    .limit(1)
  if (running)
    throw new Reject(
      'this account pays for a bill that is still running: hand the bill to someone else or cancel the plan first',
    )
}
