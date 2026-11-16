// The handlers of self-serve sign-up (account.signUp, signup.*) and the daily sign-up sweep (docs/billing.md §3.1).
// Apart from self-serve.ts, which the sign-in gate imports, so that the gate does not pull in workspace creation and
// deletion (and with them the handler registry) while it loads.
import type { AccountSignUpData } from '@linedesk/actions'
import {
  billing_accounts,
  billing_balances,
  CARD_FINGERPRINT_RETENTION_MONTHS,
  card_fingerprints,
  ledger_entries,
  member,
  organization,
  SIGNUP_COUNTRIES,
  session,
  signup_attempts,
  type Tx,
  user,
} from '@linedesk/db'
import { and, eq, inArray, isNull, lt, sql } from 'drizzle-orm'
import { billingProvider } from './billing-settings.ts'
import type { Actor } from './context.ts'
import { Forbidden, type Handler, Reject } from './handler-context.ts'
import { isInstanceAdmin } from './instance-admin.ts'
import { queueBillingAlert } from './jobs.ts'
import { addToWorkspace } from './memberships.ts'
import { emailHash, SIGNUP_CODE_WINDOW_MS, selfServeState, signupRules } from './self-serve.ts'
import { insertWorkspace } from './workspace-creation-handlers.ts'
import { deleteAccounts, deleteWorkspace } from './workspace-delete.ts'

const DAY = 24 * 3_600_000

// --- account.signUp -----------------------------------------------------------------------------------

/** What someone outside the sign-up countries is told (the page shows its own "not yet" text first). */
export const COUNTRY_NOT_YET = 'Linedesk is not available in this country yet.'
export const SIGNUP_CLOSED = 'Sign-up is not open on this server.'

/** Only a person signed in as themselves signs up: never an API key, a setup link, the agent or an impersonation. */
function refuseSignUpActor(actor: Actor) {
  if (
    actor.impersonation ||
    actor.apiKeyId ||
    actor.personalKeyId ||
    actor.setupKeyId ||
    actor.role === 'agent' ||
    !actor.sessionId
  )
    throw new Forbidden('only you, signed in to the app, can sign up')
}

type SignUpInput = {
  name: string
  businessName: string
  country: string
  plan: 'cloud'
  interval: 'year' | 'month'
  timeZone?: string
}

/** The account's sign-up waiting for Checkout, if any (one per account). */
async function waitingSignUp(tx: Tx, userId: string) {
  const [row] = await tx
    .select({ bill: billing_accounts, workspace: { id: organization.id, name: organization.name } })
    .from(billing_accounts)
    .innerJoin(organization, eq(organization.billingAccountId, billing_accounts.id))
    .where(and(eq(billing_accounts.owner_user_id, userId), eq(billing_accounts.status, 'pending_payment')))
    .limit(1)
  return row ?? null
}

const signUp: Handler = async (ctx, input: SignUpInput) => {
  const { tx, actor, now } = ctx
  refuseSignUpActor(actor)
  const [me] = await tx.select().from(user).where(eq(user.id, actor.actorId)).for('update')
  if (!me || me.disabledAt) throw new Forbidden('only you, signed in to the app, can sign up')
  if (!(await selfServeState(tx)).open) throw new Forbidden(SIGNUP_CLOSED)
  if (!me.emailVerified) throw new Forbidden('confirm your email address first')
  // One sign-up waiting for Checkout per account: asked again (a second tab, a reload), it is answered.
  const waiting = await waitingSignUp(tx, me.id)
  if (waiting) {
    const data: AccountSignUpData = { billId: waiting.bill.id, workspace: waiting.workspace, existing: true }
    return { rows: {}, data: { ...data, subject: { email: me.email, workspaceId: waiting.workspace.id } } }
  }
  if (!(SIGNUP_COUNTRIES as readonly string[]).includes(input.country)) throw new Reject(COUNTRY_NOT_YET)
  const billId = crypto.randomUUID()
  await tx.insert(billing_accounts).values({
    id: billId,
    kind: input.plan,
    owner_user_id: me.id,
    status: 'pending_payment',
    interval: input.interval,
    created_at: now,
    updated_at: now,
  })
  const org = await insertWorkspace(ctx, {
    name: input.businessName,
    country: input.country,
    ...(input.timeZone ? { timeZone: input.timeZone } : {}),
  })
  await tx
    .update(organization)
    .set({ billingAccountId: billId, billingState: 'pending_payment' })
    .where(eq(organization.id, org.id))
  if (input.name !== me.name) await tx.update(user).set({ name: input.name }).where(eq(user.id, me.id))
  await addToWorkspace(tx, me, org, 'owner', now)
  await tx.update(session).set({ activeOrganizationId: org.id }).where(eq(session.id, actor.sessionId!))
  const data: AccountSignUpData = { billId, workspace: { id: org.id, name: org.name }, existing: false }
  // The audit log files the entry under the new workspace, with its owner.
  return { rows: {}, data: { ...data, subject: { email: me.email, workspaceId: org.id } } }
}

// Opening and closing sign-up (`signup.setSelfServe`, `signup.getSelfServe`) are Server admin › Billing's actions
// (billing-admin.ts, PR 13).
export const selfServeHandlers: Record<string, Handler> = {
  'account.signUp': signUp,
}

// --- The daily sign-up sweep ------------------------------------------------------------------------------

export type SweepResult = {
  bills: number
  workspaces: number
  accounts: number
  attempts: number
  fingerprints: number
}

/**
 * Deletes sign-ups that never finished Checkout (docs/billing.md §3.1): bills still `pending_payment` after
 * `pendingDays`, with no ledger rows, no linked Stripe subscription and no confirmed Checkout (those are kept and the
 * instance admins told), their workspaces, and their owner's account when it is in no other workspace and not an
 * instance admin. Also accounts the sign-up page made (an email code there, then nothing) that are in no
 * workspace after `pendingDays`, the sign-up attempts older than `pendingDays` + 2 days, and the card fingerprints of
 * bills canceled more than CARD_FINGERPRINT_RETENTION_MONTHS ago. Each bill in its own transaction, so one failure
 * leaves the rest done.
 */
export async function sweepSignUps(
  db: { transaction: <T>(work: (tx: Tx) => Promise<T>) => Promise<T> },
  now = Date.now(),
): Promise<SweepResult> {
  const result: SweepResult = { bills: 0, workspaces: 0, accounts: 0, attempts: 0, fingerprints: 0 }
  const rules = await db.transaction(tx => signupRules(tx))
  const before = new Date(now - rules.pendingDays * DAY).toISOString()
  const stale = await db.transaction(tx =>
    tx
      .select({ id: billing_accounts.id })
      .from(billing_accounts)
      .where(and(eq(billing_accounts.status, 'pending_payment'), lt(billing_accounts.created_at, before))),
  )
  for (const { id } of stale) {
    try {
      const done = await db.transaction(tx => sweepBill(tx, id, before, new Date(now).toISOString()))
      if (done) {
        result.bills++
        result.workspaces += done.workspaces
        result.accounts += done.accounts
      }
    } catch (e) {
      console.error(`sign-up sweep: bill ${id} not deleted:`, e)
    }
  }
  result.accounts += await db.transaction(tx => sweepCodeOnlyAccounts(tx, before))
  result.attempts = await db.transaction(async tx => {
    const old = new Date(now - (rules.pendingDays + 2) * DAY).toISOString()
    const gone = await tx
      .delete(signup_attempts)
      .where(lt(signup_attempts.created_at, old))
      .returning({ id: signup_attempts.id })
    return gone.length
  })
  result.fingerprints = await db.transaction(tx => sweepCardFingerprints(tx, now))
  return result
}

/**
 * A card fingerprint (one trial per card) is kept while its bill runs and for CARD_FINGERPRINT_RETENTION_MONTHS after
 * the bill was canceled (its cancel time, else the end of its last period), then deleted (docs/billing.md §3.2).
 */
async function sweepCardFingerprints(tx: Tx, now: number): Promise<number> {
  const before = new Date(now)
  before.setUTCMonth(before.getUTCMonth() - CARD_FINGERPRINT_RETENTION_MONTHS)
  const ended = tx
    .select({ id: billing_accounts.id })
    .from(billing_accounts)
    .where(
      and(
        eq(billing_accounts.status, 'canceled'),
        lt(
          sql`coalesce(${billing_accounts.canceled_at}, ${billing_accounts.current_period_end})`,
          before.toISOString(),
        ),
      ),
    )
  const gone = await tx
    .delete(card_fingerprints)
    .where(inArray(card_fingerprints.first_billing_account_id, ended))
    .returning({ fingerprint: card_fingerprints.fingerprint })
  return gone.length
}

/** One stale sign-up, checked again under the bill's lock; null when it no longer qualifies. */
async function sweepBill(tx: Tx, billId: string, before: string, now: string) {
  const [bill] = await tx.select().from(billing_accounts).where(eq(billing_accounts.id, billId)).for('update')
  if (bill?.status !== 'pending_payment' || Date.parse(bill.created_at) >= Date.parse(before)) return null
  // A Stripe subscription linked to a bill still waiting (invoice.paid before the Checkout confirmation, a trial or a
  // paid plan), or a confirmed Checkout, is a customer: never swept. It should not stay pending_payment, so the
  // instance admins are told on every daily run until someone looks (review of #919, N2).
  if (bill.stripe_subscription_id || bill.checkout_confirmed_at) {
    console.error(`sign-up sweep: bill ${billId} waits for Checkout but has a subscription or a confirmation; kept`)
    await queueBillingAlert(tx, { kind: 'signup_kept', bill: billId, subscription: bill.stripe_subscription_id })
    return null
  }
  // A bill with ledger rows is never deleted: money moved, a person decides (docs/billing.md §3.1).
  const [entry] = await tx
    .select({ id: ledger_entries.id })
    .from(ledger_entries)
    .where(eq(ledger_entries.billing_account_id, billId))
    .limit(1)
  if (entry) return null
  // Its Stripe side goes first (security review of #961, G2): open Checkout sessions are expired, so none can be
  // completed for a bill that is gone, and the customer is deleted (with its saved card). Any Stripe error throws
  // and the bill is kept for the next run.
  if (bill.stripe_customer_id) {
    const provider = await billingProvider(tx)
    await provider.expireOpenCheckouts(bill.stripe_customer_id)
    await provider.deleteCustomer(bill.stripe_customer_id)
  }
  const workspaces = await tx
    .select({ id: organization.id, name: organization.name })
    .from(organization)
    .where(eq(organization.billingAccountId, billId))
  // The owner is spared by deleteWorkspace and decided on below, so a member elsewhere keeps their account.
  for (const w of workspaces) await deleteWorkspace(tx, { workspaceId: w.id, name: w.name }, now, bill.owner_user_id)
  await tx.delete(billing_balances).where(eq(billing_balances.billing_account_id, billId))
  await tx.delete(billing_accounts).where(eq(billing_accounts.id, billId))
  const accounts = (await deleteIdleAccount(tx, bill.owner_user_id)) ? 1 : 0
  return { workspaces: workspaces.length, accounts }
}

/** The account goes when it is in no workspace, owns no other bill and is not an instance admin. */
async function deleteIdleAccount(tx: Tx, userId: string): Promise<boolean> {
  const [account] = await tx.select().from(user).where(eq(user.id, userId)).for('update')
  if (!account || isInstanceAdmin(account)) return false
  const [inWorkspace] = await tx.select({ id: member.id }).from(member).where(eq(member.userId, userId)).limit(1)
  if (inWorkspace) return false
  const [otherBill] = await tx
    .select({ id: billing_accounts.id })
    .from(billing_accounts)
    .where(eq(billing_accounts.owner_user_id, userId))
    .limit(1)
  if (otherBill) return false
  await deleteAccounts(tx, [userId])
  return true
}

/**
 * Accounts the sign-up page made that never signed up: created within SIGNUP_CODE_WINDOW_MS after a code was asked
 * for there, older than `before`, in no workspace and owning no bill. Other accounts without a workspace are left alone.
 */
async function sweepCodeOnlyAccounts(tx: Tx, before: string): Promise<number> {
  const candidates = await tx
    .select({ id: user.id, email: user.email, createdAt: user.createdAt })
    .from(user)
    .leftJoin(member, eq(member.userId, user.id))
    .where(and(isNull(member.id), lt(user.createdAt, new Date(before))))
  if (!candidates.length) return 0
  const hashes = candidates.map(c => emailHash(c.email))
  const attempts = await tx
    .select({ hash: signup_attempts.email_hash, at: signup_attempts.created_at })
    .from(signup_attempts)
    .where(and(eq(signup_attempts.kind, 'code'), inArray(signup_attempts.email_hash, hashes)))
  let deleted = 0
  for (const c of candidates) {
    const made = c.createdAt.getTime()
    const hash = emailHash(c.email)
    const bySignupPage = attempts.some(a => {
      const at = Date.parse(a.at)
      return a.hash === hash && at <= made && made - at <= SIGNUP_CODE_WINDOW_MS
    })
    if (bySignupPage && (await deleteIdleAccount(tx, c.id))) deleted++
  }
  return deleted
}
