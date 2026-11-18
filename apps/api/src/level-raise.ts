// Who may raise an assistant's call quality to Premium or Ultra (decisions.md 2026-11-17): only someone who may pay,
// the rule of Allow Premium and Allow Ultra before (LIN-440, #1158): who manages the bill (its owner, or an owner or
// admin of the only workspace a Cloud bill pays for); the workspace's owner when it is on no bill; in a white-label
// client only the partner's owner. Lowering a level, or changing models within it, is anyone's who edits the assistant.
import { billing_accounts, organization, type Tx } from '@linedesk/db'
import { eq } from 'drizzle-orm'
import { managesBill } from './bill-manager.ts'
import { refuseUnlessBillOwner } from './billing-owner.ts'
import type { Actor } from './context.ts'
import { Forbidden, Reject } from './handler-context.ts'
import { isPartnerOwner, PARTNER_DECIDES_LEVELS } from './partner-refusals.ts'
import { refuseBillingActor, usageLevelsBilled } from './usage-levels.ts'

/**
 * Who switches Allow Premium or Allow Ultra (security review of #1109, M-1): never in a disabled workspace (read only);
 * on, only who manages the bill (its owner, or an owner or admin of the only workspace it pays for: managesBill; the
 * workspace's owner where there is no bill), also where the bill's owner is only an
 * admin or a member (run-action.ts lets them ask; LIN-440); off, the workspace's owner or the bill's owner. In a white-label client (docs/white-label.md, LIN-440) its partner's owner decides, both ways, and the client's
 * own owner never does: the partner pays and sets what its client may use. Anyone else holding billing:manage here
 * gets 403.
 */
export async function refuseAllowSwitch(tx: Tx, actor: Actor, on: boolean) {
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
  if (on || actor.role !== 'owner') await refuseUnlessBillOwner(tx, actor)
}

/**
 * What the caller may do with Allow Premium and Allow Ultra here, as refuseAllowSwitch decides it (read without locks,
 * for the settings page: the switch is disabled for anyone it would refuse; LIN-440).
 */
export async function allowSwitchOf(tx: Tx, actor: Actor): Promise<{ on: boolean; off: boolean }> {
  const none = { on: false, off: false }
  if (!actor.workspaceId || actor.workspaceDisabled) return none
  if (actor.impersonation || actor.apiKeyId || actor.personalKeyId || actor.setupKeyId) return none
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
  if (!org || (org.billId && !org.billOwner)) return none
  // Who manages the bill (managesBill: its owner, or an owner or admin of its only workspace); without a bill, the
  // workspace's owner.
  const ownsBill =
    org.billId && org.billOwner && org.billKind
      ? await managesBill(tx, actor, { id: org.billId, owner_user_id: org.billOwner, kind: org.billKind })
      : actor.role === 'owner'
  if (org.partnerId) {
    const may = ownsBill && (await isPartnerOwner(tx, org.partnerId, actor.actorId))
    return { on: may, off: may }
  }
  return { on: ownsBill, off: ownsBill || actor.role === 'owner' }
}

/**
 * Whether this member may raise an assistant to a paid level here (allowSwitchOf's `on`, read without locks, for the
 * editor: Premium and Ultra are greyed for anyone it would refuse). Always on an install that does not bill usage.
 */
export async function mayRaiseLevel(tx: Tx, actor: Actor): Promise<boolean> {
  if (!(await usageLevelsBilled(tx))) return true
  return (await allowSwitchOf(tx, actor)).on
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
    await refuseAllowSwitch(tx, actor, true)
  } catch (e) {
    if (e instanceof Forbidden) throw Forbidden.t('server.api.callQualityRaise')
    throw e
  }
}
