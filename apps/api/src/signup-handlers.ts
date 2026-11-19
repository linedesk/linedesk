// The handlers of self-serve sign-up (account.signUp, signup.*) and the daily sign-up sweep (docs/billing.md §3.1).
// Apart from self-serve.ts, which the sign-in gate imports, so that the gate does not pull in workspace creation and
// deletion (and with them the handler registry) while it loads.
import type { AccountSignUpData, CountryHint } from '@linedesk/actions'
import {
  billing_accounts,
  billing_balances,
  CARD_FINGERPRINT_RETENTION_MONTHS,
  card_fingerprints,
  ledger_entries,
  member,
  organization,
  partner_invitations,
  partner_members,
  partners,
  session,
  signup_attempts,
  terms_acceptances,
  type Tx,
  user,
} from '@linedesk/db'
import type { CustomerPurchases } from '@linedesk/billing'
import { and, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm'
import { accountTrialUsed } from './billing-checkout.ts'
import { billingProvider } from './billing-settings.ts'
import type { Actor } from './context.ts'
import { Forbidden, type Handler, Reject } from './handler-context.ts'
import { isInstanceAdmin } from './instance-admin.ts'
import { COUNTRY_NOT_SERVED, countryNotYet, placeholderWorkspaceName, signupCountriesFor } from './served-countries.ts'
import { type LegalTerms, legalTerms, recordAcceptance, TERMS_CHANGED } from './legal-terms.ts'

export { TERMS_CHANGED }
import { queueBillingAlert } from './jobs.ts'
import { addToWorkspace } from './memberships.ts'
import { refusePartner } from './partner-refusals.ts'
import { emailHash, SIGNUP_CODE_WINDOW_MS, selfServeState, signupRules } from './self-serve.ts'
import { insertWorkspace } from './workspace-creation-handlers.ts'
import { deleteAccounts, deleteWorkspace } from './workspace-delete.ts'

const DAY = 24 * 3_600_000

// --- account.signUp -----------------------------------------------------------------------------------

export { COUNTRY_NOT_SERVED }
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
  /** The partner's company name (required for a partner); a business's name comes in the onboarding's Business step. */
  businessName?: string
  /** As an older sign-up page picked it; else the request's hint decides. */
  country?: string
  /** Where the request comes from (POST /v1/signup sets it from the request, never the caller). */
  countryHint?: CountryHint
  plan: 'cloud' | 'partner'
  interval: 'year' | 'month'
  timeZone?: string
  acceptedTerms: { termsVersion: string; privacyVersion: string }
}

/**
 * The account's sign-up waiting for Checkout, if any (one per account): a cloud bill with its workspace, or a partner
 * bill with its partner (no workspace yet). A bill a workspace moved to when it left its partner (partners.ts
 * detachClient) waits for its owner's card too, and is answered the same way.
 */
async function waitingSignUp(tx: Tx, userId: string): Promise<Omit<AccountSignUpData, 'existing'> | null> {
  const [row] = await tx
    .select({
      billId: billing_accounts.id,
      workspaceId: organization.id,
      workspaceName: organization.name,
      partnerId: partners.id,
      partnerName: partners.name,
    })
    .from(billing_accounts)
    .leftJoin(organization, eq(organization.billingAccountId, billing_accounts.id))
    .leftJoin(partners, eq(partners.billing_account_id, billing_accounts.id))
    .where(
      and(
        eq(billing_accounts.owner_user_id, userId),
        eq(billing_accounts.status, 'pending_payment'),
        sql`(${organization.id} is not null or ${partners.id} is not null)`,
      ),
    )
    .orderBy(billing_accounts.created_at)
    .limit(1)
  if (!row) return null
  return {
    billId: row.billId,
    workspace: row.workspaceId ? { id: row.workspaceId, name: row.workspaceName ?? '' } : null,
    partner: row.partnerId ? { id: row.partnerId, name: row.partnerName ?? '' } : null,
  }
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
    const data: AccountSignUpData = { ...waiting, existing: true }
    return { rows: {}, data: { ...data, subject: { email: me.email, workspaceId: waiting.workspace?.id ?? null } } }
  }
  // The country gate (docs/billing.md §3.2): only a country picked (an older page) outside the sign-up countries is
  // refused. Where the request comes from (the hint) never is: someone abroad may run a business in a served country
  // (2026-11-18). The onboarding's Business step asks for the business's own country, served ones only, and Checkout
  // refuses a workspace whose country is another one (served-countries.ts). Each country's sign-up mode (open, only
  // invited addresses, off) decides (signup-access.ts).
  if (input.country && !(await signupCountriesFor(tx, me.email)).includes(input.country)) throw countryNotYet()
  // The terms the page showed must still be the ones in effect (A9): changed while the page was open, it reloads them.
  const { terms } = legalTerms()
  if (!terms) throw new Forbidden(SIGNUP_CLOSED)
  if (
    input.acceptedTerms.termsVersion !== terms.termsVersion ||
    input.acceptedTerms.privacyVersion !== terms.privacyVersion
  )
    throw Reject.t('server.api.signup.termsChanged', undefined, TERMS_CHANGED)
  if (input.plan === 'partner') return partnerSignUp(ctx, me, input, terms)
  const billId = crypto.randomUUID()
  // One free trial per account (decision of 2026-11-17): decided now, so the activation step and Checkout sell the
  // plan from today and nobody learns it at the card. The card rule (card_used, prepaid) still applies on top.
  const trialUsed = await accountTrialUsed(tx, me.id)
  await tx.insert(billing_accounts).values({
    id: billId,
    kind: input.plan,
    owner_user_id: me.id,
    status: 'pending_payment',
    interval: input.interval,
    ...(trialUsed ? { trial_refused: 'account_used' as const } : {}),
    created_at: now,
    updated_at: now,
  })
  // The business's name and country come in the Business step: until then a placeholder name, and the country only as
  // picked (an older page), else Automatic on the request's hint.
  const org = await insertWorkspace(ctx, {
    name: input.businessName ?? placeholderWorkspaceName(actor.locale),
    ...(input.country ? { country: input.country } : {}),
    ...(input.countryHint ? { countryHint: input.countryHint } : {}),
    ...(input.timeZone ? { timeZone: input.timeZone } : {}),
  })
  await tx
    .update(organization)
    .set({ billingAccountId: billId, billingState: 'pending_payment' })
    .where(eq(organization.id, org.id))
  if (input.name !== me.name) await tx.update(user).set({ name: input.name }).where(eq(user.id, me.id))
  await addToWorkspace(tx, me, org, 'owner', now)
  await recordAcceptance(tx, { userId: me.id, billId, sessionId: actor.sessionId!, terms, now, source: 'signup' })
  await tx.update(session).set({ activeOrganizationId: org.id }).where(eq(session.id, actor.sessionId!))
  const data: AccountSignUpData = { billId, workspace: { id: org.id, name: org.name }, partner: null, existing: false }
  // The audit log files the entry under the new workspace, with its owner.
  return { rows: {}, data: { ...data, subject: { email: me.email, workspaceId: org.id } } }
}

/**
 * Plan `partner` (docs/white-label.md, S2): the partner (pending a server admin's approval, which gates its brand) with
 * the caller as its owner, and the partner bill waiting for Checkout. No workspace: its client workspaces are made in
 * the partner area once the bill runs, each a seat on the bill. One partner per owner.
 */
async function partnerSignUp(
  ctx: Parameters<Handler>[0],
  me: typeof user.$inferSelect,
  input: SignUpInput,
  terms: LegalTerms,
): Promise<{ rows: Record<string, never>; data: AccountSignUpData & { subject: unknown } }> {
  const { tx, actor, now } = ctx
  const [owning] = await tx
    .select({ id: partner_members.partner_id })
    .from(partner_members)
    .where(and(eq(partner_members.user_id, me.id), eq(partner_members.role, 'owner')))
  if (owning) throw refusePartner('already_partner')
  // The schema asks for it; checked again, as the partner's name is its brand until a server admin approves it.
  const partnerName = input.businessName
  if (!partnerName) throw Reject.t('server.api.signup.partnerNameMissing')
  const billId = crypto.randomUUID()
  await tx.insert(billing_accounts).values({
    id: billId,
    kind: 'partner',
    owner_user_id: me.id,
    status: 'pending_payment',
    interval: input.interval,
    created_at: now,
    updated_at: now,
  })
  const partnerId = `ptn_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`
  await tx.insert(partners).values({
    id: partnerId,
    name: partnerName,
    billing_account_id: billId,
    created_by: me.id,
    created_at: now,
    updated_at: now,
  })
  await tx.insert(partner_members).values({ partner_id: partnerId, user_id: me.id, role: 'owner', created_at: now })
  await recordAcceptance(tx, { userId: me.id, billId, sessionId: actor.sessionId!, terms, now, source: 'signup' })
  if (input.name !== me.name) await tx.update(user).set({ name: input.name }).where(eq(user.id, me.id))
  // Every instance admin hears of it, so the approval does not sit unnoticed (sent once the sign-up is committed).
  await queueBillingAlert(tx, { kind: 'partner_signup', partner: partnerId })
  const data: AccountSignUpData = {
    billId,
    workspace: null,
    partner: { id: partnerId, name: partnerName },
    existing: false,
  }
  return { rows: {}, data: { ...data, subject: { email: me.email, workspaceId: null } } }
}

/** What the app offers a Cloud customer in the workspace menu (`/v1/me` `newWorkspace`); null: nothing. */
export type NewWorkspaceOffer = {
  /** The account still has its free trial (one per account): false, the plan starts at Checkout. */
  trial: boolean
  /** The interval of the account's latest Cloud bill: the new workspace's bill starts with the same. */
  interval: 'month' | 'year'
  /** The account's sign-up waiting for Checkout: the menu opens it ("Finish setting up") instead of a new one. */
  waiting: { id: string; name: string } | null
}

/**
 * Whether this person may add a workspace of their own from the app (decision of 2026-11-17): a Cloud customer (owns a
 * Cloud bill that pays for a workspace), signed in as themselves, with a confirmed address, while self-serve sign-up
 * is open. Never someone on a partner team (they make clients in the partner area), never in a partner's client
 * workspace. The same `account.signUp` makes it, so every check there still runs.
 */
export async function newWorkspaceOffer(
  tx: Tx,
  actor: Actor,
  current: { partnerId: string | null } | null,
): Promise<NewWorkspaceOffer | null> {
  if (actor.impersonation || actor.apiKeyId || actor.personalKeyId || actor.setupKeyId || actor.role === 'agent')
    return null
  // Sign-up and Checkout answer only on the install's own address (request-host.ts).
  if (!actor.sessionId || actor.partnerHost || current?.partnerId) return null
  const [me] = await tx
    .select({ id: user.id, verified: user.emailVerified, disabledAt: user.disabledAt })
    .from(user)
    .where(eq(user.id, actor.actorId))
  if (!me?.verified || me.disabledAt) return null
  const [onTeam] = await tx
    .select({ id: partner_members.partner_id })
    .from(partner_members)
    .where(eq(partner_members.user_id, me.id))
    .limit(1)
  if (onTeam) return null
  const [bill] = await tx
    .select({ interval: billing_accounts.interval })
    .from(billing_accounts)
    .innerJoin(organization, eq(organization.billingAccountId, billing_accounts.id))
    .where(and(eq(billing_accounts.owner_user_id, me.id), eq(billing_accounts.kind, 'cloud')))
    .orderBy(desc(billing_accounts.created_at))
    .limit(1)
  if (!bill) return null
  if (!(await selfServeState(tx)).open) return null
  const waiting = await waitingSignUp(tx, me.id)
  return {
    trial: !(await accountTrialUsed(tx, me.id)),
    interval: bill.interval,
    waiting: waiting?.workspace ?? null,
  }
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
 * `pendingDays`, with no ledger rows, no linked Stripe subscription and no confirmed Checkout, and whose customer has
 * no running subscription or completed Checkout in Stripe itself (those are kept and the instance admins told), their
 * workspaces, and their owner's account when it is in no other workspace and not an
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
  const workspaces = await tx
    .select({ id: organization.id, name: organization.name, createdAt: organization.createdAt })
    .from(organization)
    .where(eq(organization.billingAccountId, billId))
  // A workspace older than its bill moved there (it left its partner, partners.ts detachClient): not a sign-up that
  // never finished, but a business with its calls and contacts. It waits for its owner's card and is never swept.
  if (workspaces.some(w => w.createdAt.getTime() < Date.parse(bill.created_at))) return null
  if (bill.stripe_customer_id && !(await stripeSideGone(tx, billId, bill.stripe_customer_id))) return null
  // The owner is spared by deleteWorkspace and decided on below, so a member elsewhere keeps their account.
  for (const w of workspaces) await deleteWorkspace(tx, { workspaceId: w.id, name: w.name }, now, bill.owner_user_id)
  // A partner sign-up that never finished: the partner goes with its bill (its team and invitations with it).
  await tx.delete(partners).where(eq(partners.billing_account_id, billId))
  await tx.delete(billing_balances).where(eq(billing_balances.billing_account_id, billId))
  // Never a customer: the acceptance goes with the bill (A9).
  await tx.delete(terms_acceptances).where(eq(terms_acceptances.billing_account_id, billId))
  await tx.delete(billing_accounts).where(eq(billing_accounts.id, billId))
  const accounts = (await deleteIdleAccount(tx, bill.owner_user_id)) ? 1 : 0
  return { workspaces: workspaces.length, accounts }
}

/**
 * The Stripe side of a stale sign-up goes before its bill (security review of #961, G2): open Checkout sessions are
 * expired, so none can be completed for a bill that is gone, and the customer is deleted (with its saved card). In
 * between, Stripe itself is asked what the customer bought (security verification of #961, V-1): a Checkout completed
 * there whose webhook was not applied yet (delayed, or the webhook down) left nothing in our database, and deleting the
 * customer would cancel a subscription the card may already have paid. Such a bill is kept and the instance admins
 * are told, like a linked one (N2). When Stripe cannot be asked, the bill is kept for the next run and the admins are
 * told too. True when the customer is gone and the bill may be deleted.
 */
async function stripeSideGone(tx: Tx, billId: string, customer: string): Promise<boolean> {
  let bought: CustomerPurchases
  try {
    const provider = await billingProvider(tx)
    // Expired first, so no session is completed between the look below and the deletion.
    await provider.expireOpenCheckouts(customer)
    bought = await provider.customerPurchases(customer)
    if (!bought.subscriptionId && !bought.checkoutSessionId) {
      await provider.deleteCustomer(customer)
      return true
    }
  } catch (e) {
    console.error(`sign-up sweep: bill ${billId} kept, Stripe could not be asked about its customer:`, e)
    await queueBillingAlert(tx, {
      kind: 'signup_kept',
      bill: billId,
      subscription: null,
      reason: 'stripe_error',
      customer,
    })
    return false
  }
  console.error(`sign-up sweep: bill ${billId} waits for Checkout but its customer bought in Stripe; kept`)
  await queueBillingAlert(tx, {
    kind: 'signup_kept',
    bill: billId,
    subscription: bought.subscriptionId,
    reason: 'in_stripe',
    customer,
    session: bought.checkoutSessionId,
  })
  return false
}

/** The account goes when it is in no workspace and no partner team, owns no other bill and is not an instance admin. */
async function deleteIdleAccount(tx: Tx, userId: string): Promise<boolean> {
  const [account] = await tx.select().from(user).where(eq(user.id, userId)).for('update')
  if (!account || isInstanceAdmin(account)) return false
  const [inWorkspace] = await tx.select({ id: member.id }).from(member).where(eq(member.userId, userId)).limit(1)
  if (inWorkspace) return false
  const [onPartnerTeam] = await tx
    .select({ id: partner_members.partner_id })
    .from(partner_members)
    .where(eq(partner_members.user_id, userId))
    .limit(1)
  if (onPartnerTeam) return false
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
 * Accounts made by an email code that were never used: by the sign-up page, or for a partner invitation that ended
 * unused (withdrawn or expired). Accounts the sign-up page made that never signed up: created within SIGNUP_CODE_WINDOW_MS after a code was asked
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
  // Made for a white-label partner invitation (instance-admin.ts, joinOrUndo) whose invitation ended unused: in no
  // workspace and on no partner team, like an account the sign-up page made and nobody used (security review of #1100).
  const partnerInvites = await tx
    .select({
      email: partner_invitations.email,
      createdAt: partner_invitations.created_at,
      acceptedAt: partner_invitations.accepted_at,
      canceledAt: partner_invitations.canceled_at,
      expiresAt: partner_invitations.expires_at,
    })
    .from(partner_invitations)
    .where(
      inArray(
        partner_invitations.email,
        candidates.map(c => c.email.toLowerCase()),
      ),
    )
  let deleted = 0
  for (const c of candidates) {
    const made = c.createdAt.getTime()
    const hash = emailHash(c.email)
    const bySignupPage = attempts.some(a => {
      const at = Date.parse(a.at)
      return a.hash === hash && at <= made && made - at <= SIGNUP_CODE_WINDOW_MS
    })
    const byPartnerInvitation = partnerInvites.some(
      i => i.email === c.email.toLowerCase() && Date.parse(i.createdAt) <= made,
    )
    const stillInvited = partnerInvites.some(
      i => i.email === c.email.toLowerCase() && !i.acceptedAt && !i.canceledAt && Date.parse(i.expiresAt) > Date.now(),
    )
    if ((bySignupPage || (byPartnerInvitation && !stillInvited)) && (await deleteIdleAccount(tx, c.id))) deleted++
  }
  return deleted
}
