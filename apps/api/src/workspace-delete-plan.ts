// Deleting a workspace ends the plan it alone paid for (LIN-647; a removed workspace is never refunded). A Cloud bill
// whose only workspace this is would otherwise keep its Stripe subscription charging for nothing, with no workspace
// left to cancel it from (seen on staging: a server admin's delete with "Keep their accounts"). So, whatever happens to
// the accounts:
// - before the transaction (the preparers of workspace.delete and workspace.deleteOwn), the subscription is canceled
//   in Stripe at once: no proration, no final invoice, no refund for the rest of the period (the terms; a yearly plan's
//   14-day refund stays on request). Every refusal the delete can give is checked first, so a refused delete never
//   ends a plan: the name, and the accounts it deletes that own another running bill. Stripe not answering refuses the
//   delete: a workspace never goes while its plan still charges;
// - in the transaction, under the bill's balance lock, the bill becomes `canceled` (as markCanceled does, without its
//   numbers-release email: the workspace and its numbers go now). Stripe's `customer.subscription.deleted` then finds
//   it canceled and changes nothing.
// A partner's bill and a bill with other workspaces go on (their seats follow: seatsFollowDelete). With Stripe keys
// connected but billing not in effect the delete is refused; only an install without Stripe asks nothing of it.
import { billing_accounts, organization, type Tx } from '@linedesk/db'
import { and, count, eq, ne } from 'drizzle-orm'
import { refuseDeletingBillOwners } from './billing-owner.ts'
import { billingProvider, billingState } from './billing-settings.ts'
import { db } from './db.ts'
import { type Preparer, Reject } from './handler-context.ts'
import { lockBalance } from './ledger.ts'
import { membersOnlyHere } from './workspace-delete.ts'
import { ownedWorkspace } from './workspace-delete-own.ts'

/** The plan a delete ends: its bill and the Stripe subscription. */
export type EndingPlan = { billId: string; subscriptionId: string }

/**
 * The plan that ends with this workspace: a Cloud bill whose only workspace it is, with a subscription that may still
 * charge (any status but `canceled`). Null for everything else.
 */
export async function planEndingWith(tx: Tx, workspaceId: string): Promise<EndingPlan | null> {
  const [row] = await tx
    .select({
      billId: billing_accounts.id,
      kind: billing_accounts.kind,
      status: billing_accounts.status,
      subscriptionId: billing_accounts.stripe_subscription_id,
    })
    .from(organization)
    .innerJoin(billing_accounts, eq(billing_accounts.id, organization.billingAccountId))
    .where(eq(organization.id, workspaceId))
  if (!row?.subscriptionId || row.kind !== 'cloud' || row.status === 'canceled') return null
  const [others] = await tx
    .select({ n: count() })
    .from(organization)
    .where(and(eq(organization.billingAccountId, row.billId), ne(organization.id, workspaceId)))
  if ((others?.n ?? 0) > 0) return null
  return { billId: row.billId, subscriptionId: row.subscriptionId }
}

/**
 * Before the delete's transaction: cancels the plan that ends with the workspace in Stripe, once the delete would not
 * be refused for its name or for an account it deletes. `spareUserId`, `keepAccounts`: as deleteWorkspace gets them.
 * What the transaction then closes (endPlanWithDelete), or null.
 */
export async function cancelPlanBeforeDelete(input: {
  workspaceId: string
  name: string
  keepAccounts: boolean
  spareUserId: string | null
}): Promise<EndingPlan | null> {
  const ending = await db.transaction(async tx => {
    const [workspace] = await tx
      .select({ name: organization.name })
      .from(organization)
      .where(eq(organization.id, input.workspaceId))
    if (!workspace) throw Reject.t('server.api.workspaceDelete.notFound')
    // The same refusal as deleteWorkspace's, before anything leaves the database.
    if (workspace.name.trim().toLowerCase() !== input.name.trim().toLowerCase())
      throw Reject.t('server.api.workspaceDelete.typeName', { name: workspace.name })
    const plan = await planEndingWith(tx, input.workspaceId)
    if (!plan) return null
    // An account the delete takes that owns another running bill refuses it (deleteAccounts): asked now, not after
    // the plan is gone. This plan's own bill is the one the delete ends.
    if (!input.keepAccounts) {
      const accounts = await membersOnlyHere(tx, input.workspaceId, input.spareUserId)
      await refuseDeletingBillOwners(
        tx,
        accounts.map(a => a.id),
        plan.billId,
      )
    }
    return plan
  })
  if (!ending) return null
  const state = await billingState(db)
  if (state.inEffect === 'none') {
    // Stripe keys connected but billing not in effect right now (turned off for a key rotation, live keys not allowed,
    // the ledger guards failing, even for a moment): the subscription may still charge and cannot be canceled from
    // here, so the delete waits (security review of #1483, M). Only an install that never connected Stripe has no plan
    // to cancel there; its bill is closed all the same.
    if (state.connected) throw Reject.t('server.api.workspaceDelete.billingPaused')
    return ending
  }
  const provider = await billingProvider(db)
  try {
    await provider.cancelSubscription(ending.subscriptionId, { now: true })
  } catch (error) {
    console.error(`billing: the plan of bill ${ending.billId} could not be canceled for a workspace delete:`, error)
    throw Reject.t('server.api.workspaceDelete.planNotCanceled')
  }
  return ending
}

/**
 * In the delete's transaction, before the workspace goes: the bill of the plan the preparer canceled becomes
 * `canceled`. Refused when the plan that ends is not the one canceled (a workspace moved or a plan started meanwhile).
 * Whether a plan ended.
 */
export async function endPlanWithDelete(
  tx: Tx,
  workspaceId: string,
  prepared: EndingPlan | null | undefined,
  now: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ billId: organization.billingAccountId })
    .from(organization)
    .where(eq(organization.id, workspaceId))
  if (!row?.billId) return false
  // The bill's lock order (ledger.ts): its balance row first, so a workspace moved onto it waits or is seen here.
  await lockBalance(tx, row.billId)
  const ending = await planEndingWith(tx, workspaceId)
  // A plan was canceled before the transaction but none ends now (a workspace moved onto the bill meanwhile,
  // billing.moveWorkspace): refused, never deleted as if nothing had happened (security review of #1483, L).
  if (!ending) {
    if (prepared) throw Reject.t('server.api.workspaceDelete.planChanged')
    return false
  }
  if (prepared?.billId !== ending.billId || prepared.subscriptionId !== ending.subscriptionId)
    throw Reject.t('server.api.workspaceDelete.planChanged')
  await tx
    .update(billing_accounts)
    .set({ status: 'canceled', canceled_at: now, cancel_at_period_end: false, updated_at: now })
    .where(eq(billing_accounts.id, ending.billId))
  return true
}

/** The preparers of the two deletes: a server admin's (who keeps their own account) and an owner's own. */
export const workspaceDeletePreparers: Record<string, Preparer> = {
  'workspace.delete': ({ actor }, input: { workspaceId: string; name: string; keepAccounts?: boolean }) =>
    cancelPlanBeforeDelete({
      workspaceId: input.workspaceId,
      name: input.name,
      keepAccounts: input.keepAccounts === true,
      spareUserId: actor.actorId,
    }),
  'workspace.deleteOwn': async ({ actor }, input: { name: string; keepOwnAccount?: boolean; keepAccounts?: boolean }) =>
    cancelPlanBeforeDelete({
      // Only an owner of the workspace, as the handler checks again (never while impersonating, never an agent).
      workspaceId: await db.transaction(tx => ownedWorkspace(tx, actor)),
      name: input.name,
      keepAccounts: input.keepAccounts === true,
      spareUserId: input.keepOwnAccount ? actor.actorId : null,
    }),
}
