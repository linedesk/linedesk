// The partner bill (docs/white-label.md "Partner bill", docs/billing.md §6; white-label slice S2): one bill per
// white-label partner (`billing_accounts.kind = 'partner'`, `partners.billing_account_id`), owned by the partner's owner.
// Its subscription has the partner base fee and one seat per client workspace; every client workspace is on it, and
// all their usage comes from its one balance. Here: which partner bill a caller may manage, whether a new client
// workspace may go on it, and the seats that follow the client workspaces in Stripe after a change committed.
import type { BillingProvider } from '@linedesk/billing'
import { billing_accounts, organization, partner_members, partners, type Tx } from '@linedesk/db'
import { msg } from '@linedesk/i18n'
import { and, eq, sql } from 'drizzle-orm'
import { alertInstanceAdmins } from './admin-alerts.ts'
import { pricesForCheckout } from './billing-catalog.ts'
import { billingProvider, billingSwitchOn } from './billing-settings.ts'
import type { Actor } from './context.ts'
import { db } from './db.ts'
import { seatsSyncAlert } from './emails/alerts.ts'
import { syncExtraCallsItem } from './extra-calls.ts'
import { WEB_ORIGIN } from './emails/templates.ts'
import { Forbidden, Reject, type Said } from './handler-context.ts'
import { queueSeatSync } from './jobs.ts'
import { lockBalance } from './ledger.ts'
import { refusePartner } from './partner-refusals.ts'
import { signupRules } from './self-serve.ts'

type Bill = typeof billing_accounts.$inferSelect

/** Partner › Billing: where Checkout's "back", the portal's return and a top-up's cancel lead for a partner bill. */
export const PARTNER_BILLING_URL = () => `${WEB_ORIGIN}/#partner/billing`

const NOT_THE_OWNER: Said = { key: msg('server.api.checkout.notTheOwner') }

/**
 * The bill of partner `partnerId`, for its owner only (Partner › Billing, `partnerId` in a billing action): the caller
 * must be the partner's owner and the bill's owner. Anyone else, also an admin of that partner or a member of another,
 * gets the same 403 whether the partner exists or not.
 */
export async function partnerBillOf(tx: Tx, actor: Actor, partnerId: string): Promise<string> {
  const [row] = await tx
    .select({ bill: partners.billing_account_id, role: partner_members.role })
    .from(partner_members)
    .innerJoin(partners, eq(partners.id, partner_members.partner_id))
    .where(and(eq(partner_members.partner_id, partnerId), eq(partner_members.user_id, actor.actorId)))
  if (row?.role !== 'owner') throw new Forbidden(NOT_THE_OWNER)
  if (!row.bill) throw Reject.t('server.api.checkout.noBill')
  const [bill] = await tx
    .select({ owner: billing_accounts.owner_user_id })
    .from(billing_accounts)
    .where(eq(billing_accounts.id, row.bill))
  if (bill?.owner !== actor.actorId) throw new Forbidden(NOT_THE_OWNER)
  return row.bill
}

/** Bill states in which a client workspace may be added: the plan runs (in its trial, paid, or comped). */
const TAKES_CLIENTS: readonly Bill['status'][] = ['trialing', 'active', 'past_due', 'comped']

/** How many workspaces are on a bill. */
export async function workspacesOnBillCount(tx: Tx | typeof db, billId: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(organization)
    .where(eq(organization.billingAccountId, billId))
  return row?.n ?? 0
}

/**
 * The partner bill a new client workspace goes on (its balance row locked), or null where billing is off and the
 * partner has no bill (self-host, dev: S1's ceiling applies instead). Refused: a billed install without a partner bill
 * (a partner a server admin made by hand), a bill before its Checkout, a bill that does not run, and in the free trial
 * more client workspaces than the sign-up rules allow (`trialWorkspacesPartner`, docs/billing.md §3.1). The caller holds
 * the partner row's lock, so two creations cannot both pass the trial limit.
 */
export async function billForNewClient(tx: Tx, partner: { billing_account_id: string | null }): Promise<Bill | null> {
  if (!partner.billing_account_id) {
    if (await billingSwitchOn(tx)) throw refusePartner('client_needs_bill')
    return null
  }
  await lockBalance(tx, partner.billing_account_id)
  const [bill] = await tx.select().from(billing_accounts).where(eq(billing_accounts.id, partner.billing_account_id))
  if (!bill) throw refusePartner('client_needs_bill')
  if (bill.status === 'pending_payment') throw refusePartner('bill_not_started')
  if (!TAKES_CLIENTS.includes(bill.status)) throw refusePartner('bill_inactive')
  if (bill.status === 'trialing') {
    const rules = await signupRules(tx)
    if ((await workspacesOnBillCount(tx, bill.id)) >= rules.trialWorkspacesPartner)
      throw refusePartner('trial_client_limit')
  }
  return bill
}

/** The workspaces' mirror of their bill's state (`organization.billing_state`), as billing-admin.ts keeps it. */
export function mirroredState(status: Bill['status']): 'pending_payment' | 'active' | 'suspended' {
  if (status === 'pending_payment') return 'pending_payment'
  return status === 'suspended' || status === 'canceled' ? 'suspended' : 'active'
}

/**
 * Seats follow the client workspaces (docs/billing.md §2.1): the subscription's seat quantity is set to the workspaces
 * on the bill now (syncSeats), never inside the request (security review of #1113, L-3). A `partner.seatSync` job is
 * queued in the caller's transaction, so it runs only once the change committed and survives a restart; Stripe being
 * down holds neither the request nor a database connection of it. The job is tried again with backoff and, after its
 * last try, emailed to the instance admins; the nightly reconciliation reports the bill's seats until the next change.
 * A raise is prorated (yearly: paid now; monthly: on the next invoice), a drop is not refunded, decided by the change
 * Stripe sees, not by the event that started the sync. `extraCalls`: a client leaving had extra calls at the same
 * time, so the bill's extra-calls item drops to the sum left too (no refund; security review of #1109, M-2).
 * Without a job queue (tests, a script) the sync runs once after the commit instead.
 */
export async function seatsFollow(
  tx: Tx,
  onCommit: ((work: () => Promise<void>) => void) | undefined,
  billId: string,
  key: string,
  { extraCalls = false }: { extraCalls?: boolean } = {},
) {
  const job: SeatSyncJob = { billId, key, extraCalls }
  if (await queueSeatSync(tx, job)) return
  if (!onCommit) throw new Error('partner seats change after the commit: no onCommit given')
  onCommit(() => runSeatSync(job, { last: true }))
}

/** The bill's extra-calls item to the sum left, never charged (syncExtraCallsItem alerts the admins on a failure). */
async function extraCallsFollow(billId: string, key: string) {
  await syncExtraCallsItem(await billingProvider(db), billId, { charge: false, key: `extra_calls_${key}` })
}

/** A `partner.seatSync` job: the bill whose seats follow, what changed (for Stripe's idempotency key). */
export type SeatSyncJob = { billId: string; key: string; extraCalls: boolean }

/**
 * One try of a seat sync job. A failure throws, so the job runner tries again later, except on the `last` try: then
 * the instance admins get an email (security review of #1109, L-1) and the job ends. The extra-calls item follows once
 * the seats are set, or on the last try whatever happened to them.
 */
export async function runSeatSync(job: SeatSyncJob, { last, provider }: { last: boolean; provider?: BillingProvider }) {
  try {
    await syncSeats(job.billId, job.key, provider)
  } catch (error) {
    if (!last) throw error
    console.error(`ALERT billing seats: partner bill ${job.billId} not updated after ${job.key}`, error)
    await alertInstanceAdmins(seatsSyncAlert(job.billId)).catch(e =>
      console.error('billing: the seats alert could not be sent:', e),
    )
  }
  if (job.extraCalls) await extraCallsFollow(job.billId, job.key)
}

/** The seat items' lookup keys start with it (`ws_monthly`, `ws_yearly`; SEAT_LOOKUP_PREFIX in the Stripe adapter). */
const SEAT_LOOKUP_PREFIX = 'ws_'

/** How the change from `current` seats to `quantity` is prorated: a raise is charged, a drop is not refunded. */
export const seatProration = (current: number, quantity: number, interval: Bill['interval']) =>
  quantity <= current
    ? ('none' as const)
    : interval === 'year'
      ? ('always_invoice' as const)
      : ('create_prorations' as const)

/**
 * Sets the subscription's seats to the workspaces on the bill now. One sync per bill at a time (an advisory lock held
 * while Stripe is asked, never the balance lock), and the proration follows what actually changes in Stripe: the seats
 * the subscription has now against the count (security review of #1109, L-1). So a sync that missed a raise before, or
 * two syncs that overlap, never add a seat without its proration.
 */
export async function syncSeats(billId: string, key: string, provider?: BillingProvider) {
  await db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`seats:${billId}`}))`)
    const [bill] = await tx.select().from(billing_accounts).where(eq(billing_accounts.id, billId))
    if (!bill?.stripe_subscription_id) return
    const stripe = provider ?? (await billingProvider(db))
    const quantity = await workspacesOnBillCount(tx, bill.id)
    const subscription = await stripe.subscription(bill.stripe_subscription_id)
    // i18n-ignore: a log line and the admins' alert reason, never shown to a customer
    if (!subscription) throw new Error(`subscription ${bill.stripe_subscription_id} not found`)
    const current = subscription.items
      .filter(item => item.lookupKey?.startsWith(SEAT_LOOKUP_PREFIX))
      .reduce((sum, item) => sum + item.quantity, 0)
    if (current === quantity) return
    const prices = await pricesForCheckout(stripe)
    const seatPrice = prices[bill.interval === 'year' ? 'ws_yearly' : 'ws_monthly']
    await stripe.setSeatQuantity({
      subscriptionId: bill.stripe_subscription_id,
      quantity,
      prorationBehavior: seatProration(current, quantity, bill.interval),
      // The same change asks Stripe the same thing: a retry of it is idempotent, a later change is a new request.
      idempotencyKey: `seats_${key}_${bill.id}_${current}_${quantity}`,
      ...(seatPrice ? { seatPrice } : {}),
    })
  })
}

/**
 * A workspace about to be deleted: when it is a client on its partner's bill, that bill's seats drop after the commit
 * (no refund). On any bill with a subscription, its extra calls at the same time leave the bill's extra-calls item too
 * (security review of #1109, M-2). Called before the delete, while the workspace still names its bill.
 */
export async function seatsFollowDelete(
  tx: Tx,
  onCommit: ((work: () => Promise<void>) => void) | undefined,
  workspaceId: string,
) {
  const [row] = await tx
    .select({
      bill: billing_accounts.id,
      kind: billing_accounts.kind,
      subscription: billing_accounts.stripe_subscription_id,
      extraCalls: organization.extraCalls,
    })
    .from(organization)
    .innerJoin(billing_accounts, eq(billing_accounts.id, organization.billingAccountId))
    .where(eq(organization.id, workspaceId))
  if (!row) return
  const key = `delete_${workspaceId}`
  const extraCalls = row.extraCalls > 0 && !!row.subscription
  if (row.kind === 'partner') await seatsFollow(tx, onCommit, row.bill, key, { extraCalls })
  else if (extraCalls) {
    if (!onCommit) throw new Error('extra calls change after the commit: no onCommit given')
    onCommit(() => extraCallsFollow(row.bill, key))
  }
}
