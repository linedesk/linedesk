// Who may raise an assistant's call quality to Premium or Ultra (decisions.md 2026-11-17): only someone who may pay
// (LIN-440, #1158): who manages the bill (its owner, or an owner or admin of the only workspace a Cloud bill pays for);
// the workspace's owner when it is on no bill; in a white-label client only the partner's owner. Picking the level is
// the consent; there are no Allow switches (call quality 4/5). Lowering a level, or changing models within it, is
// anyone's who edits the assistant.
import { billing_accounts, organization, type Tx } from '@linedesk/db'
import { eq } from 'drizzle-orm'
import { managesBill } from './bill-manager.ts'
import { refuseUnlessBillOwner } from './billing-owner.ts'
import type { Actor } from './context.ts'
import { Forbidden, LEVEL_RAISE_REFUSED, Reject } from './handler-context.ts'
import { isPartnerOwner, PARTNER_DECIDES_LEVELS } from './partner-refusals.ts'
import { refuseBillingActor, usageLevelsBilled } from './usage-levels.ts'

/**
 * Refused (403) unless the caller may pay here (security review of #1109, M-1): never in a disabled workspace (read
 * only); who manages the bill (its owner, or an owner or admin of the only workspace it pays for: managesBill; the
 * workspace's owner where there is no bill). In a white-label client (docs/white-label.md, LIN-440) only its partner's
 * owner, never the client's own owner: the partner pays.
 */
async function refuseUnlessMayPay(tx: Tx, actor: Actor) {
  if (actor.workspaceDisabled) throw Reject.t('server.api.workspaceDisabled')
  const [org] = actor.workspaceId
    ? await tx
        .select({ partnerId: organization.partnerId, bill: organization.billingAccountId })
        .from(organization)
        .where(eq(organization.id, actor.workspaceId))
    : []
  if (org?.partnerId) {
    if (!(await isPartnerOwner(tx, org.partnerId, actor.actorId))) throw new Forbidden(PARTNER_DECIDES_LEVELS)
    // A client without a bill: only as its owner, as before LIN-440 let admins and members ask (review of #1140, L-1).
    if (!org.bill && actor.role !== 'owner') throw new Forbidden(PARTNER_DECIDES_LEVELS)
    // On the partner bill, its owner is the partner's owner: checked (and the bill locked) as for every bill.
    if (org.bill) await refuseUnlessBillOwner(tx, actor)
    return
  }
  await refuseUnlessBillOwner(tx, actor)
}

/** Whether the caller may pay here, as refuseUnlessMayPay decides it (read without locks; LIN-440). */
async function mayPay(tx: Tx, actor: Actor): Promise<boolean> {
  if (!actor.workspaceId || actor.workspaceDisabled) return false
  if (actor.impersonation || actor.apiKeyId || actor.personalKeyId || actor.setupKeyId) return false
  const [org] = await tx
    .select({
      partnerId: organization.partnerId,
      billId: organization.billingAccountId,
      billOwner: billing_accounts.owner_user_id,
      billKind: billing_accounts.kind,
    })
    .from(organization)
    .leftJoin(billing_accounts, eq(billing_accounts.id, organization.billingAccountId))
    .where(eq(organization.id, actor.workspaceId))
  // A bill id without its bill: refused by the handler (refuseUnlessBillOwner), so nobody here.
  if (!org || (org.billId && !org.billOwner)) return false
  // Who manages the bill (managesBill: its owner, or an owner or admin of its only workspace); without a bill, the
  // workspace's owner.
  const ownsBill =
    org.billId && org.billOwner && org.billKind
      ? await managesBill(tx, actor, { id: org.billId, owner_user_id: org.billOwner, kind: org.billKind })
      : actor.role === 'owner'
  if (org.partnerId) return Boolean(ownsBill) && (await isPartnerOwner(tx, org.partnerId, actor.actorId))
  return Boolean(ownsBill)
}

/**
 * Whether this member may raise an assistant to a paid level here (mayPay, read without locks, for the
 * editor: Premium and Ultra are greyed for anyone it would refuse). Always on an install that does not bill usage.
 */
export async function mayRaiseLevel(tx: Tx, actor: Actor): Promise<boolean> {
  if (!(await usageLevelsBilled(tx))) return true
  return mayPay(tx, actor)
}

/**
 * Whether a new assistant may start on a paid level (assistant.create: the install's default, or a copy's level): as
 * refuseLevelRaise decides it, under the same shared bill lock, so a change of the bill's owner at the same moment waits
 * for the new assistant and then moves it back, or commits first and the new assistant starts on Standard (as a raise
 * does, LIN-438). mayRaiseLevel reads without that lock and is only for what the editor offers.
 */
export async function mayStartOnPaidLevel(tx: Tx, actor: Actor): Promise<boolean> {
  if (actor.workspaceDisabled) return false
  try {
    await refuseLevelRaise(tx, actor)
    return true
  } catch (e) {
    if (e instanceof Forbidden) return false
    throw e
  }
}

/**
 * Before a save raises an assistant to Premium or Ultra on Linedesk Cloud: refused unless the caller may pay, signed in
 * as themselves in the app (refuseBillingActor), never through an API key or an impersonation. Locks the bill (shared)
 * until the save commits, so a change of the bill's owner waits for it and then moves the assistant back (LIN-438).
 * Nothing on an install that does not bill usage.
 */
export async function refuseLevelRaise(tx: Tx, actor: Actor) {
  if (!(await usageLevelsBilled(tx))) return
  try {
    refuseBillingActor(actor)
    await refuseUnlessMayPay(tx, actor)
  } catch (e) {
    // Every refusal here, a 403 or another (a disabled workspace), is logged as a refused raise for the audit log.
    const refusal = e instanceof Forbidden ? Forbidden.t('server.api.callQualityRaise') : e
    if (refusal instanceof Reject) refusal.reason = LEVEL_RAISE_REFUSED
    throw refusal
  }
}
