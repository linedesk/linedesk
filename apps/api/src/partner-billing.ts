// The partner bill (docs/white-label.md "Partner bill"; white-label slice S2): one bill per
// white-label partner (`billing_accounts.kind = 'partner'`, `partners.billing_account_id`), owned by the partner's owner.
// Its subscription has the partner base fee and one seat per client workspace; every client workspace is on it, and
// all their usage comes from its one balance. Here: which partner bill a caller may manage, whether a new client
// workspace may go on it, and the seats that follow the client workspaces in Stripe after a change committed.
import { UNPAID_PARTNER_CLIENTS } from '@linedesk/actions'
import type { BillingProvider } from '@linedesk/billing'
import { billing_accounts, organization, partner_members, partners, type Tx } from '@linedesk/db'
import { msg } from '@linedesk/i18n'
import { and, eq, sql } from 'drizzle-orm'
import { alertInstanceAdmins } from './admin-alerts.ts'
import { pricesForCheckout } from './billing-catalog.ts'
import { billingProvider, billingSwitchOn } from './billing-settings.ts'
import type { Actor } from './context.ts'
import { db } from './db.ts'
import { extraCallsSyncAlert, seatsSyncAlert } from './emails/alerts.ts'
import { syncExtraCallsItem } from './extra-calls.ts'
import { WEB_ORIGIN } from './emails/templates.ts'
import { Forbidden, Reject, type Said } from './handler-context.ts'
import { queueSeatSync } from './jobs.ts'
import { lockBalance } from './ledger.ts'
import { refusePartner } from './partner-refusals.ts'

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
 * (a partner a server admin made by hand), a bill before its Checkout, and a bill that does not run. No trial and so no
 * trial limit: the partner plan is paid from its Checkout.
 *
 * `draft`: a new client workspace the partner prepares (workspace.createForClient). Before the Checkout the partner sets
 * up first (setup before payment, 2026-11-18): at most UNPAID_PARTNER_CLIENTS of them go on the bill waiting for its
 * Checkout, cost nothing until it is paid (the Checkout then sells their seats with the base fee) and wait for it like a
 * Cloud sign-up's workspace (`pending_payment`: no number, no calls, no invitations, self-serve.ts). The caller holds
 * the partner row's lock, so two creations cannot both pass the cap.
 */
export async function billForNewClient(
  tx: Tx,
  partner: { billing_account_id: string | null },
  { draft = false }: { draft?: boolean } = {},
): Promise<Bill | null> {
  if (!partner.billing_account_id) {
    if (await billingSwitchOn(tx)) throw refusePartner('client_needs_bill')
    return null
  }
  await lockBalance(tx, partner.billing_account_id)
  const [bill] = await tx.select().from(billing_accounts).where(eq(billing_accounts.id, partner.billing_account_id))
  if (!bill) throw refusePartner('client_needs_bill')
  if (bill.status === 'pending_payment') {
    if (!draft) throw refusePartner('bill_not_started')
    if ((await workspacesOnBillCount(tx, bill.id)) >= UNPAID_PARTNER_CLIENTS) throw refusePartner('unpaid_client_limit')
    return bill
  }
  if (!TAKES_CLIENTS.includes(bill.status)) throw refusePartner('bill_inactive')
  return bill
}

/** The workspaces' mirror of their bill's state (`organization.billing_state`), as billing-admin.ts keeps it. */
export function mirroredState(status: Bill['status']): 'pending_payment' | 'active' | 'suspended' {
  if (status === 'pending_payment') return 'pending_payment'
  return status === 'suspended' || status === 'canceled' ? 'suspended' : 'active'
}

/**
 * Seats follow the client workspaces: the subscription's seat quantity is set to the workspaces
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
 * How long one try of a seat sync job may take, each step (the seats, then the extra-calls item): together well below
 * the job's expiry (PARTNER_SEAT_SYNC_EXPIRE_SECONDS in jobs.ts), so a hanging Stripe call or lock wait ends in the
 * catch below, with its alert, never in a silent expiry (security review of #1115, L-2). Each Stripe request has its
 * own client timeout too (STRIPE_TIMEOUT_MS, 8 s).
 */
export const SEAT_SYNC_STEP_MS = 100_000

/** `work`, or a rejection once `ms` passed; the timer never keeps the process up. */
export function withDeadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => {
    // i18n-ignore: an error for the server log and the job runner, never shown to anyone
    timer = setTimeout(() => reject(new Error(`${what}: no answer after ${ms} ms`)), ms)
    timer.unref?.()
  })
  return Promise.race([work, late]).finally(() => clearTimeout(timer))
}

/**
 * One try of a seat sync job. A failure throws, so the job runner tries again later, except on the `last` try: then
 * the instance admins get an email (security review of #1109, L-1) and the job ends. The extra-calls item follows once
 * the seats are set, or on the last try whatever happened to them. A job that still ends failed (it expired, the
 * worker stopped) goes to the dead-letter queue, whose worker sends the same email (seatSyncFailed).
 */
export async function runSeatSync(
  job: SeatSyncJob,
  { last, provider, stepMs = SEAT_SYNC_STEP_MS }: { last: boolean; provider?: BillingProvider; stepMs?: number },
) {
  try {
    await withDeadline(syncSeats(job.billId, job.key, provider), stepMs, 'partner seats')
  } catch (error) {
    if (!last) throw error
    await seatSyncFailed(job, error).catch(e => console.error('billing: the seats alert could not be sent:', e))
  }
  if (!job.extraCalls) return
  const extra = withDeadline(extraCallsFollow(job.billId, job.key), stepMs, 'partner extra calls')
  if (!last) return extra
  // The last try ends here, with one email that says what failed (security review of #1116, L-2): syncExtraCallsItem
  // emails the admins about a Stripe failure itself; what reaches this catch (no provider, the deadline) did not.
  await extra.catch(async e => {
    console.error(`ALERT billing extra calls: partner bill ${job.billId} not updated after ${job.key}`, e)
    await alertInstanceAdmins(extraCallsSyncAlert(job.billId)).catch(err =>
      console.error('billing: the extra-calls alert could not be sent:', err),
    )
  })
}

/** The bill's seats did not follow: logged and emailed to the instance admins; throws when no email could go out. */
export async function seatSyncFailed(job: SeatSyncJob, error?: unknown) {
  console.error(`ALERT billing seats: partner bill ${job.billId} not updated after ${job.key}`, error ?? '')
  await alertInstanceAdmins(seatsSyncAlert(job.billId))
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
 * (security review of #1109, M-2). Called before the delete, while the workspace still names its bill. Nothing on a
 * canceled bill.
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
      status: billing_accounts.status,
      extraCalls: organization.extraCalls,
    })
    .from(organization)
    .innerJoin(billing_accounts, eq(billing_accounts.id, organization.billingAccountId))
    .where(eq(organization.id, workspaceId))
  // A canceled bill's subscription ended in Stripe (billing-lifecycle.ts markCanceled): nothing left to lower there, and
  // Stripe refuses changes to it (the 90-day delete of data-purge.ts deletes only workspaces of canceled bills).
  if (!row || row.status === 'canceled') return
  const key = `delete_${workspaceId}`
  const extraCalls = row.extraCalls > 0 && !!row.subscription
  if (row.kind === 'partner') await seatsFollow(tx, onCommit, row.bill, key, { extraCalls })
  else if (extraCalls) {
    if (!onCommit) throw new Error('extra calls change after the commit: no onCommit given')
    onCommit(() => extraCallsFollow(row.bill, key))
  }
}
