// An owner deletes their own workspace (workspace.deleteOwn, Workspace settings › Danger zone), and what the dialog
// shows before it (workspace.deletePreview). The delete itself is the admin's (workspace-delete.ts): every row, the
// recordings, the numbers at the carrier, the accounts of members who belong to no other workspace. On top:
// - only an owner of this workspace, never while impersonating, and only after a fresh sign-in (owner-step-up.ts);
// - every other member is emailed (who deleted it and when; whether their account went with it), queued in the
//   delete's transaction;
// - the owner's own account follows the members' rule (no other workspace, not an instance admin: it goes, and
//   with it every session) unless they keep it (`keepOwnAccount`); `keepAccounts` keeps every account, the owner's
//   included (they then wait for an invitation).
import type { WorkspaceDeleteOwnData, WorkspaceDeletePreviewData } from '@linedesk/actions'
import { calls, contacts, member, organization, phone_numbers, type Tx, user, workspace_settings } from '@linedesk/db'
import { and, asc, count, eq, ne } from 'drizzle-orm'
import type { Actor } from './context.ts'
import { emailSafeName } from './emails/templates.ts'
import { Forbidden, type HandlerCtx, Reject } from './handler-context.ts'
import { NOT_WHILE_IMPERSONATING } from './impersonation-guard.ts'
import { queueWorkspaceDeletedEmails } from './jobs.ts'
import { ownerStepUpNeeded, ownerStepUpRefusal } from './owner-step-up.ts'
import { seatsFollowDelete } from './partner-billing.ts'
import { deleteWorkspace, membersOnlyHere } from './workspace-delete.ts'

export const ONLY_OWNER = 'Only an owner can delete this workspace.'

/** The caller's workspace, when they own it; refuses everyone else. */
async function ownedWorkspace(tx: Tx, actor: Actor): Promise<string> {
  if (actor.impersonation) throw new Forbidden(NOT_WHILE_IMPERSONATING)
  if (!actor.workspaceId || actor.role === 'agent') throw new Forbidden(ONLY_OWNER)
  const [me] = await tx
    .select({ role: member.role })
    .from(member)
    .where(and(eq(member.organizationId, actor.workspaceId), eq(member.userId, actor.actorId)))
  if (me?.role !== 'owner') throw new Forbidden(ONLY_OWNER)
  return actor.workspaceId
}

/** Whether the owner's account would go with the workspace: not an instance admin, and no other workspace. */
async function ownAccountGoes(tx: Tx, workspaceId: string, ownerId: string): Promise<boolean> {
  return (await membersOnlyHere(tx, workspaceId, null)).some(u => u.id === ownerId)
}

const countOf = async (query: Promise<{ n: number }[]>) => (await query)[0]?.n ?? 0

export async function deletePreview({ tx, actor }: HandlerCtx) {
  const workspaceId = await ownedWorkspace(tx, actor)
  const [workspace] = await tx
    .select({ name: organization.name })
    .from(organization)
    .where(eq(organization.id, workspaceId))
  if (!workspace) throw new Reject('workspace not found')
  const numbers = await tx
    .select({ purchased: phone_numbers.purchased, account: phone_numbers.carrier_account })
    .from(phone_numbers)
    .where(eq(phone_numbers.workspace_id, workspaceId))
  // What releaseAtCarrier does: bought in the install's account → released; everything else stays the business's.
  const bought = numbers.filter(n => n.purchased && n.account === 'install').length
  const data: WorkspaceDeletePreviewData = {
    name: workspace.name,
    calls: await countOf(tx.select({ n: count() }).from(calls).where(eq(calls.workspace_id, workspaceId))),
    contacts: await countOf(tx.select({ n: count() }).from(contacts).where(eq(contacts.workspace_id, workspaceId))),
    numbers: { bought, attached: numbers.length - bought },
    otherMembers: await countOf(
      tx
        .select({ n: count() })
        .from(member)
        .where(and(eq(member.organizationId, workspaceId), ne(member.userId, actor.actorId))),
    ),
    accountsDeleted: (await membersOnlyHere(tx, workspaceId, actor.actorId)).length,
    ownAccountDeleted: await ownAccountGoes(tx, workspaceId, actor.actorId),
    stepUp: await ownerStepUpNeeded(tx, actor),
  }
  return { rows: {}, data }
}

export async function deleteOwn(
  { tx, actor, now, telephony, onCommit }: HandlerCtx,
  input: { name: string; keepOwnAccount?: boolean; keepAccounts?: boolean },
) {
  const workspaceId = await ownedWorkspace(tx, actor)
  // Checked by run-action before the transaction too; here so no other path can skip it.
  const stepUp = await ownerStepUpNeeded(tx, actor)
  if (stepUp) throw new Forbidden(ownerStepUpRefusal(stepUp).error)

  const [workspace] = await tx
    .select({ name: organization.name })
    .from(organization)
    .where(eq(organization.id, workspaceId))
  if (!workspace) throw new Reject('workspace not found')
  const [settings] = await tx
    .select({ timezone: workspace_settings.timezone })
    .from(workspace_settings)
    .where(eq(workspace_settings.workspace_id, workspaceId))
  const [owner] = await tx.select({ name: user.name, email: user.email }).from(user).where(eq(user.id, actor.actorId))
  const others = await tx
    .select({ id: user.id, email: user.email })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(and(eq(member.organizationId, workspaceId), ne(member.userId, actor.actorId)))

  await seatsFollowDelete(tx, onCommit, workspaceId)
  const result = await deleteWorkspace(
    tx,
    { workspaceId, name: input.name, keepAccounts: input.keepAccounts },
    now,
    input.keepOwnAccount ? actor.actorId : null,
    telephony,
  )

  const deleted = new Set(result.usersDeleted)
  const ownGoes = !!owner && deleted.has(owner.email)
  const name = emailSafeName(owner?.name, '')
  const by = name ? `${name} (${owner!.email})` : (owner?.email ?? null)
  const content = {
    workspace: emailSafeName(workspace.name, '') || null,
    by,
    byRole: 'owner' as const,
    at: now,
    timeZone: settings?.timezone ?? null,
  }
  await queueWorkspaceDeletedEmails(
    tx,
    others.map(o => ({ to: o.email, ...content, accountDeleted: deleted.has(o.email) })),
  )

  const [next] = ownGoes
    ? []
    : await tx
        .select({ id: member.organizationId })
        .from(member)
        .where(eq(member.userId, actor.actorId))
        .orderBy(asc(member.createdAt))
        .limit(1)
  const data: WorkspaceDeleteOwnData = { ...result, nextWorkspaceId: next?.id ?? null, ownAccountDeleted: ownGoes }
  return { rows: {}, data }
}
