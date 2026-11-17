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
import { billing_accounts, organization, type Tx } from '@linedesk/db'
import { eq } from 'drizzle-orm'
import type { Actor } from './context.ts'
import type { db } from './db.ts'

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
