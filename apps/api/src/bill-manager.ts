// Who manages a bill (docs/billing.md §8; decision of 2026-11-17, "an admin should also be able to do changes on
// billing, so not just the owner"):
//
// - the bill's owner, always (also a partner bill's owner, the partner's owner);
// - an owner or admin of the one workspace a Linedesk Cloud bill pays for: the bill covers their workspace alone, so
//   it is theirs to manage as much as the owner's.
//
// Nobody else: never a member, never on a partner bill (the partner pays and decides, docs/white-label.md), and never
// on a bill that pays for several workspaces (an admin of one of them must not change what the others pay; they get
// the usage view of their own workspace, as before). Keys (API, personal, setup link) never manage a bill they do not
// own; whether an impersonation may read or act is each caller's rule (refuseBillingActor), as for the owner.
//
// When someone who manages the bill but does not own it cancels or resumes the plan, changes the extra calls at the
// same time or puts a new card on the bill in the Stripe portal, the owner gets one short email (decision of
// 2026-11-17; security review of #1158, note 5). The owner's own changes send nothing.
import type { BillingProvider } from '@linedesk/billing'
import { type billing_accounts, billing_alerts, commands, organization, type Tx } from '@linedesk/db'
import { and, desc, eq, gte } from 'drizzle-orm'
import { queueLifecycleEmail } from './billing-periods.ts'
import { billingProvider } from './billing-settings.ts'
import type { Actor } from './context.ts'
import { db } from './db.ts'
import type { ManagerChange } from './emails/billing-lifecycle.ts'

type Reader = Pick<Tx, 'select'> | typeof db
type BillRef = Pick<typeof billing_accounts.$inferSelect, 'id' | 'kind' | 'owner_user_id'>

/** Whether the actor manages `bill`: its owner, or an owner or admin of the only workspace it pays for. */
export async function managesBill(tx: Reader, actor: Actor, bill: BillRef): Promise<boolean> {
  if (bill.owner_user_id === actor.actorId) return true
  return adminOfOnlyWorkspace(tx, actor, bill)
}

/** An owner or admin of the actor's workspace, signed in as a person, where that workspace is the bill's only one. */
async function adminOfOnlyWorkspace(tx: Reader, actor: Actor, bill: BillRef): Promise<boolean> {
  if (bill.kind !== 'cloud') return false
  if (!actor.workspaceId || actor.workspaceDisabled) return false
  if (actor.role !== 'owner' && actor.role !== 'admin') return false
  if (actor.apiKeyId || actor.personalKeyId || actor.setupKeyId) return false
  const workspaces = await tx
    .select({ id: organization.id })
    .from(organization)
    .where(eq(organization.billingAccountId, bill.id))
    .limit(2)
  return workspaces.length === 1 && workspaces[0]!.id === actor.workspaceId
}

/**
 * Queues the owner's email about a change `actor` made to `bill` in the caller's transaction, unless the actor owns
 * it. Once per change: a retried command is answered from the command log and never runs its handler again.
 */
export async function tellBillOwner(tx: Tx, actor: Actor, bill: BillRef, change: ManagerChange, at: string) {
  if (bill.owner_user_id === actor.actorId) return
  await queueLifecycleEmail(tx, bill.id, { kind: 'manager_changed', actorId: actor.actorId, at, ...change })
}

/**
 * How long after someone opened the Stripe portal a new card on the bill counts as theirs: a portal session lasts
 * about an hour once opened.
 */
export const PORTAL_SESSION_MS = 60 * 60_000

type CardBill = Pick<
  typeof billing_accounts.$inferSelect,
  'id' | 'kind' | 'owner_user_id' | 'stripe_customer_id' | 'stripe_subscription_id'
>

/**
 * A card change on a Linedesk Cloud bill (`payment_method.attached`, `customer.updated`; stripe-events.ts): when the
 * card the bill is charged to now was added within a portal session someone else than the owner opened (the latest
 * `billing.openPortal` before the card was made, at most PORTAL_SESSION_MS earlier, from the command log), the owner
 * gets one email, once per card (`billing_alerts` kind `manager_change`, ref `card:<id>`), however many events the
 * change sends. Stripe is asked only when such a portal session exists. Whether an email was queued.
 */
export async function tellOwnerOfCardChange(bill: CardBill, now: string, provider?: BillingProvider) {
  if (bill.kind !== 'cloud' || !bill.stripe_customer_id) return false
  const workspaces = await db
    .select({ id: organization.id })
    .from(organization)
    .where(eq(organization.billingAccountId, bill.id))
  if (workspaces.length !== 1) return false
  // Every portal opened on the bill's workspace in the last week, latest first (a webhook can come late: Stripe retries
  // for days).
  const recent = await db
    .select({ actorId: commands.actor_id, at: commands.created_at })
    .from(commands)
    .where(
      and(
        eq(commands.action, 'billing.openPortal'),
        eq(commands.rejected, false),
        eq(commands.workspace_id, workspaces[0]!.id),
        gte(commands.created_at, new Date(Date.parse(now) - 7 * 86_400_000).toISOString()),
      ),
    )
    .orderBy(desc(commands.created_at))
  if (!recent.some(p => p.actorId !== bill.owner_user_id)) return false
  const stripe = provider ?? (await billingProvider(db))
  if (stripe.name === 'none') return false
  const card = await stripe.rechargeCard(bill.stripe_customer_id, bill.stripe_subscription_id)
  if (!card?.createdAt) return false
  const madeAt = Date.parse(card.createdAt)
  // The latest portal opened before the card was made (a minute of clock skew between Stripe and us allowed).
  const opener = recent.find(p => Date.parse(p.at) <= madeAt + 60_000 && Date.parse(p.at) >= madeAt - PORTAL_SESSION_MS)
  if (!opener || opener.actorId === bill.owner_user_id) return false
  return db.transaction(async tx => {
    const added = await tx
      .insert(billing_alerts)
      .values({ billing_account_id: bill.id, kind: 'manager_change', ref: `card:${card.id}` })
      .onConflictDoNothing()
      .returning()
    if (!added.length) return false
    await queueLifecycleEmail(tx, bill.id, {
      kind: 'manager_changed',
      change: 'paymentMethod',
      actorId: opener.actorId,
      at: card.createdAt!,
      card: { brand: card.brand ?? null, last4: card.last4 ?? null },
    })
    return true
  })
}
