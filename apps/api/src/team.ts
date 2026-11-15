// Team management: invitations, roles and removal, as registry handlers. Members and invitations
// are Better Auth's tables; accepting an invitation is Better Auth's endpoint (see auth.ts).
// Better Auth's own endpoints for inviting and changing members are switched off there, so these
// handlers are the only write path and the rules below always apply.
import { randomBytes } from 'node:crypto'
import { avatarUrlOf, INVITATION_DAYS, type TeamData, type TeamInvitation, type TeamMember } from '@linedesk/actions'
import { invitation, member, organization, type Tx, user, user_avatars, workspace_settings } from '@linedesk/db'
import { and, asc, eq, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { insertAuthEvent, invitationSubject, memberSubject } from './audit.ts'
import type { Actor } from './context.ts'
import { emailSender } from './email.ts'
import { addedToWorkspaceEmail, emailSafeName, invitationEmail } from './emails/templates.ts'
import { type Handler, Forbidden, Reject } from './handler-context.ts'
import { NOT_WHILE_IMPERSONATING } from './impersonation-guard.ts'
import { queueWorkspaceDeletedEmails } from './jobs.ts'
import { forgetMember, ownerJoined } from './memberships.ts'
import { LEAVE_SIGN_IN_AGAIN, leaveNeedsFreshSignIn, REMOVE_SIGN_IN_AGAIN, removeNeedsFreshSignIn } from './owner-step-up.ts'
import { createRateLimiter } from './rate-limit.ts'
import { deleteAccountWithoutWorkspace } from './workspace-delete.ts'
import { getT } from '@linedesk/i18n/server'
import { invitationLocale } from './email-locale.ts'

const WEB_ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:5173'
const DAY_MS = 86_400_000

// Invitation emails go to any address, so a workspace can send a limited number: 30 an hour,
// and one address gets at most 3 an hour (from any workspace), so nobody is flooded.
const allowEmailFor = createRateLimiter({ max: 30, windowMs: 3_600_000 })
const allowEmailTo = createRateLimiter({ max: 3, windowMs: 3_600_000 })

export { emailSafeName }

/** Unguessable: the id is the secret in the invitation link. */
const newInvitationId = () => randomBytes(24).toString('base64url')
export const invitationLink = (id: string) => `${WEB_ORIGIN}/?invite=${encodeURIComponent(id)}`

function workspaceOf(actor: Actor) {
  if (!actor.workspaceId) throw new Reject('no workspace')
  return actor.workspaceId
}

/** A pending invitation to `email` (lower case), open for INVITATION_DAYS. Not sent: see sendInvitation. */
export async function insertInvitation(
  tx: Tx,
  invite: { organizationId: string; email: string; role: string; inviterId: string; joinOnSignIn?: boolean },
  now: string,
) {
  const [row] = await tx.insert(invitation).values({
    id: newInvitationId(), organizationId: invite.organizationId, email: invite.email, role: invite.role, status: 'pending',
    expiresAt: new Date(Date.parse(now) + INVITATION_DAYS * DAY_MS), createdAt: new Date(now), inviterId: invite.inviterId,
    joinOnSignIn: invite.joinOnSignIn ?? false,
  }).returning()
  return row!
}

/** A pending invitation to `email` in this workspace, if there is one. */
export async function pendingInvitationTo(tx: Tx, workspaceId: string, email: string) {
  const [pending] = await tx.select({ id: invitation.id }).from(invitation)
    .where(and(eq(invitation.organizationId, workspaceId), eq(invitation.status, 'pending'), sql`lower(${invitation.email}) = ${email.toLowerCase()}`))
  return pending ?? null
}

/**
 * The email names the member who sent the invitation (`inviterId`), also when someone else resends it. `addedAs`:
 * a server admin added the address (Server admin › Users › Add user), so the email says so and names the role.
 */
export async function sendInvitation(
  tx: Tx,
  invite: { id: string; email: string; organizationId: string; inviterId: string },
  addedAs?: string,
) {
  if (emailSender.kind === 'none') throw new Reject('email is not set up, so invitations cannot be sent (connect it in Server admin › Providers › Email)')
  if (!allowEmailFor(invite.organizationId)) throw new Reject('too many invitations in the last hour; try again later')
  // The same answer whether or not the address has an account anywhere.
  if (!allowEmailTo(invite.email.toLowerCase())) throw new Reject('too many invitations to this address in the last hour; try again later')
  const [ws] = await tx.select({ name: organization.name }).from(organization).where(eq(organization.id, invite.organizationId))
  const [inviter] = await tx.select({ name: user.name }).from(user).where(eq(user.id, invite.inviterId))
  // The workspace's language when the web app has it, else the inviter's (email-locale.ts).
  const locale = await invitationLocale(tx, invite.organizationId, invite.inviterId)
  const { t } = getT(locale)
  const content = {
    inviter: emailSafeName(inviter?.name, addedAs ? t('email.fallback.serverAdmin') : t('email.fallback.teammate')),
    workspace: emailSafeName(ws?.name, t('email.fallback.team')),
    email: invite.email,
    url: invitationLink(invite.id),
    days: INVITATION_DAYS,
  }
  const email = addedAs
    ? addedToWorkspaceEmail({ ...content, role: addedAs }, undefined, locale)
    : invitationEmail(content, undefined, locale)
  try {
    await emailSender.send({ to: invite.email, ...email })
  } catch (err) {
    console.error('invitation email failed', err)
    throw new Reject('could not send the invitation email; try again in a moment')
  }
}

async function loadPendingInvitation(tx: Tx, workspaceId: string, invitationId: string) {
  const [row] = await tx.select().from(invitation)
    .where(and(eq(invitation.id, invitationId), eq(invitation.organizationId, workspaceId), eq(invitation.status, 'pending'))).for('update')
  if (!row) throw new Reject('invitation not found')
  return row
}

/** Locked: a role change or removal decided on this row cannot overwrite a change committed meanwhile. */
async function loadMember(tx: Tx, workspaceId: string, memberId: string) {
  const [row] = await tx.select().from(member).where(and(eq(member.id, memberId), eq(member.organizationId, workspaceId))).for('update')
  if (!row) throw new Reject('member not found')
  return row
}

/** team.leave from the last workspace without deleteAccount: the request must say whether the account goes too. */
export const LEAVE_SAY_ACCOUNT =
  'this is your only workspace: say whether to delete your account too (deleteAccount true or false). In the app, reload the page and leave again'

/** team.removeMember with deleteAccount from someone who is not the workspace's owner (Janik, 2026-11-15; LIN-264). */
export const ONLY_OWNER_DELETES_ACCOUNTS =
  "only the workspace's owner can delete a removed member's account; remove them without deleteAccount (their account stays)"

/**
 * Tells someone whose account a removal deleted (team.removeMember, membership.remove), queued in the removal's
 * transaction with the same email as a workspace delete (workspace.deletedEmail, `removed`). `by`: who removed them.
 */
export async function queueRemovedEmail(
  tx: Tx,
  to: string,
  workspaceId: string,
  by: { name: string | null; role: 'serverAdmin' | 'admin' },
  now: string,
) {
  const [ws] = await tx.select({ name: organization.name }).from(organization).where(eq(organization.id, workspaceId))
  const [settings] = await tx.select({ timezone: workspace_settings.timezone }).from(workspace_settings)
    .where(eq(workspace_settings.workspace_id, workspaceId))
  await queueWorkspaceDeletedEmails(tx, [{
    to, workspace: emailSafeName(ws?.name, '') || null, by: by.name, byRole: by.role, at: now, timeZone: settings?.timezone ?? null,
    accountDeleted: true, removed: true,
  }])
}

/**
 * A removal (team.removeMember, membership.remove) ends the removed person's right to invite to that workspace, so the
 * pending invitations they sent there are canceled with it, one audit line each (`invitation_withdrawn`; Janik,
 * 2026-11-15, LIN-264 review F1). Kept or deleted account alike: otherwise their invitations would stay valid, and after
 * a delete pass to the owner and look like the owner's own. Invitations in other workspaces are not touched here (a
 * delete passes them to those owners, workspace-delete.ts). Runs before the account delete. Returns how many.
 */
export async function cancelSentInvitations(tx: Tx, workspaceId: string, senderId: string): Promise<number> {
  const canceled = await tx.update(invitation).set({ status: 'canceled' })
    .where(and(eq(invitation.organizationId, workspaceId), eq(invitation.inviterId, senderId), eq(invitation.status, 'pending')))
    .returning({ email: invitation.email })
  for (const invite of canceled)
    await insertAuthEvent(tx, { event: 'invitation_withdrawn', userId: senderId, method: invite.email, workspaceId })
  return canceled.length
}

/** How a removal email names the member who removed someone: "Name (email)", else the address. */
async function removerLabel(tx: Tx, actorId: string) {
  const [who] = await tx.select({ name: user.name, email: user.email }).from(user).where(eq(user.id, actorId))
  if (!who) return null
  const name = emailSafeName(who.name, '')
  return name ? `${name} (${who.email})` : who.email
}

/** A workspace has exactly one owner (docs/architecture.md, "Workspace rights"): their role only changes by a transfer. */
export const OWNER_STAYS =
  "the owner's role only changes when they hand the workspace over: they make someone else the owner (Workspace settings › Team)"

/** The owner cannot be changed or removed by team.setRole and team.removeMember, not even by themselves. */
function guardOwner(target: { role: string }) {
  if (target.role === 'owner') throw new Forbidden(OWNER_STAYS)
}

/**
 * The workspace's owner row, locked: two transfers at the same moment cannot both succeed, and an owner who handed
 * the workspace over a moment ago no longer counts as one (read here, never from the session's role).
 */
async function lockedOwner(tx: Tx, workspaceId: string) {
  const [owner] = await tx.select().from(member)
    .where(and(eq(member.organizationId, workspaceId), eq(member.role, 'owner'))).for('update')
  return owner ?? null
}

/**
 * Makes `target` the owner of its workspace: the owner before (if any) becomes an admin first (the unique owner
 * index allows one at a time), and a pending owner invitation is withdrawn, so it cannot add a second owner later.
 */
export async function makeOwner(tx: Tx, target: { id: string; organizationId: string }, previousOwnerId: string | null) {
  if (previousOwnerId) await tx.update(member).set({ role: 'admin' }).where(eq(member.id, previousOwnerId))
  await tx.update(member).set({ role: 'owner' }).where(eq(member.id, target.id))
  // A server admin giving an ownerless workspace its owner (membership.setRole) starts the setup emails' clock.
  await ownerJoined(tx, target.organizationId, 'owner', new Date().toISOString())
  await tx.update(invitation).set({ status: 'canceled' })
    .where(and(eq(invitation.organizationId, target.organizationId), eq(invitation.status, 'pending'), eq(invitation.role, 'owner')))
}

async function listTeam(tx: Tx, actor: Actor): Promise<TeamData> {
  const workspaceId = workspaceOf(actor)
  const members: TeamMember[] = (await tx
    .select({ memberId: member.id, userId: user.id, name: user.name, email: user.email, role: member.role, joinedAt: member.createdAt, avatarVersion: user_avatars.version })
    .from(member).innerJoin(user, eq(user.id, member.userId))
    .leftJoin(user_avatars, eq(user_avatars.user_id, user.id))
    .where(eq(member.organizationId, workspaceId)).orderBy(asc(member.createdAt)))
    .map(({ avatarVersion, ...m }) => ({ ...m, role: m.role as TeamMember['role'], joinedAt: m.joinedAt.toISOString(), avatarUrl: avatarUrlOf(m.userId, avatarVersion) }))
  const canManage = actor.permissions.includes('team:write')
  // Invitees' addresses are for those who invite: a member sees the team, not who is invited.
  if (!canManage) return { members, invitations: [], canManage, me: actor.actorId }
  const inviter = alias(user, 'inviter')
  const now = Date.now()
  const invitations: TeamInvitation[] = (await tx
    .select({ invitationId: invitation.id, email: invitation.email, role: invitation.role, invitedBy: inviter.name, invitedById: inviter.id, expiresAt: invitation.expiresAt })
    .from(invitation).innerJoin(inviter, eq(inviter.id, invitation.inviterId))
    .where(and(eq(invitation.organizationId, workspaceId), eq(invitation.status, 'pending'))).orderBy(asc(invitation.createdAt)))
    .map(i => ({ ...i, role: i.role === 'admin' ? 'admin' : 'member', expiresAt: i.expiresAt.toISOString(), expired: i.expiresAt.getTime() < now }))
  return { members, invitations, canManage, me: actor.actorId }
}

export const teamHandlers: Record<string, Handler> = {
  'team.list': async ({ tx, actor }) => ({ rows: {}, data: await listTeam(tx, actor) }),

  'team.invite': async ({ tx, actor, now }, input: { email: string; role: string }) => {
    const workspaceId = workspaceOf(actor)
    const [already] = await tx.select({ id: member.id }).from(member).innerJoin(user, eq(user.id, member.userId))
      .where(and(eq(member.organizationId, workspaceId), sql`lower(${user.email}) = ${input.email}`))
    if (already) throw new Reject(`${input.email} is already on the team`)
    if (await pendingInvitationTo(tx, workspaceId, input.email)) throw new Reject(`${input.email} is already invited; resend the invitation instead`)
    const row = await insertInvitation(tx, { organizationId: workspaceId, email: input.email, role: input.role, inviterId: actor.actorId }, now)
    await sendInvitation(tx, row)
    return { rows: {}, data: { invitationId: row.id } }
  },

  'team.resendInvite': async ({ tx, actor, now }, input: { invitationId: string }) => {
    const invite = await loadPendingInvitation(tx, workspaceOf(actor), input.invitationId)
    await tx.update(invitation).set({ expiresAt: new Date(Date.parse(now) + INVITATION_DAYS * DAY_MS) }).where(eq(invitation.id, invite.id))
    await sendInvitation(tx, invite)
    return { rows: {}, data: { subject: invitationSubject(invite) } }
  },

  'team.revokeInvite': async ({ tx, actor }, input: { invitationId: string }) => {
    const invite = await loadPendingInvitation(tx, workspaceOf(actor), input.invitationId)
    await tx.update(invitation).set({ status: 'canceled' }).where(eq(invitation.id, invite.id))
    return { rows: {}, data: { subject: invitationSubject(invite) } }
  },

  'team.setRole': async ({ tx, actor }, input: { memberId: string; role: string }) => {
    if (actor.impersonation) throw new Forbidden(NOT_WHILE_IMPERSONATING)
    const workspaceId = workspaceOf(actor)
    const target = await loadMember(tx, workspaceId, input.memberId)
    guardOwner(target)
    // Never owner here (the input allows admin and member): that is team.transferOwnership.
    if (input.role !== 'admin' && input.role !== 'member') throw new Reject('a role change gives admin or member')
    await tx.update(member).set({ role: input.role }).where(eq(member.id, target.id))
    return { rows: {}, data: { subject: await memberSubject(tx, target.userId, target.organizationId) } }
  },

  'team.transferOwnership': async ({ tx, actor }, input: { memberId: string }) => {
    if (actor.impersonation) throw new Forbidden(NOT_WHILE_IMPERSONATING)
    const workspaceId = workspaceOf(actor)
    const owner = await lockedOwner(tx, workspaceId)
    if (!owner || owner.userId !== actor.actorId) throw new Forbidden('only the owner can hand the workspace over')
    const target = await loadMember(tx, workspaceId, input.memberId)
    if (target.id === owner.id) throw new Reject('you are the owner already')
    const [account] = await tx.select({ emailVerified: user.emailVerified, disabledAt: user.disabledAt, email: user.email })
      .from(user).where(eq(user.id, target.userId))
    if (!account || account.disabledAt) throw new Reject('this account is disabled')
    // The owner decides who may delete the workspace: only a proven address (as for owner and admin elsewhere).
    if (!account.emailVerified) throw new Reject(`${account.email} must confirm their email address before they can be the owner`)
    await makeOwner(tx, target, owner.id)
    return { rows: {}, data: { subject: await memberSubject(tx, target.userId, target.organizationId) } }
  },

  'team.leave': async ({ tx, actor }, input: { deleteAccount?: boolean }) => {
    if (actor.impersonation) throw new Forbidden(NOT_WHILE_IMPERSONATING)
    const workspaceId = workspaceOf(actor)
    // Locked: a hand-over to this member at the same moment waits, and the owner check then sees the new role.
    const [me] = await tx.select().from(member)
      .where(and(eq(member.organizationId, workspaceId), eq(member.userId, actor.actorId))).for('update')
    if (!me) throw new Reject('member not found')
    if (me.role === 'owner') throw new Reject('you are the owner: make someone else the owner first (Workspace settings › Team)')
    await tx.delete(member).where(eq(member.id, me.id))
    // The unassigned calls are not returned: the one leaving no longer sees the workspace's calls.
    await forgetMember(tx, workspaceId, actor.actorId)
    const [next] = await tx.select({ id: member.organizationId }).from(member)
      .where(eq(member.userId, actor.actorId)).orderBy(asc(member.createdAt)).limit(1)
    // Their last workspace: the account goes only when the request says so (deleteAccount: true; never a server admin's,
    // workspace-delete.ts). A request that does not say, e.g. a tab still on an older version, is refused: never a
    // silent delete. Its sessions and passkeys go with the account, its API keys stop working (no membership left).
    if (!next && input.deleteAccount === undefined) throw new Reject(LEAVE_SAY_ACCOUNT)
    // Deleting the account needs a sign-in in the last 10 minutes; checked by run-action before the transaction too.
    if (await leaveNeedsFreshSignIn(tx, actor, input)) throw new Forbidden(LEAVE_SIGN_IN_AGAIN)
    const accountDeleted = !next && input.deleteAccount === true && (await deleteAccountWithoutWorkspace(tx, actor.actorId))
    return { rows: {}, data: { nextWorkspaceId: next?.id ?? null, accountDeleted } }
  },

  'team.removeMember': async ({ tx, actor, now }, input: { memberId: string; deleteAccount?: boolean; keepAccount?: boolean }) => {
    const workspaceId = workspaceOf(actor)
    // The account stays by default; only the owner may delete it with the removal (Janik, 2026-11-15; LIN-264), read
    // from the member row: an owner who handed the workspace over a moment ago is an admin. `keepAccount` (the field
    // before) is still taken for one release and only ever keeps.
    const deleteAccount = input.deleteAccount === true && input.keepAccount !== true
    if (deleteAccount) {
      const owner = await lockedOwner(tx, workspaceId)
      if (!owner || owner.userId !== actor.actorId) throw new Forbidden(ONLY_OWNER_DELETES_ACCOUNTS)
      // And a sign-in in the last 10 minutes, as for deleting one's own (review F3); run-action checks it first too.
      if (await removeNeedsFreshSignIn(tx, actor, input)) throw new Forbidden(REMOVE_SIGN_IN_AGAIN)
    }
    const target = await loadMember(tx, workspaceId, input.memberId)
    guardOwner(target)
    const subject = await memberSubject(tx, target.userId, target.organizationId)
    await tx.delete(member).where(eq(member.id, target.id))
    const forgotten = await forgetMember(tx, target.organizationId, target.userId)
    const invitationsCanceled = await cancelSentInvitations(tx, workspaceId, target.userId)
    // Their last workspace: the account goes too when the owner asks (workspace-delete.ts), and they are told.
    const accountDeleted = deleteAccount && (await deleteAccountWithoutWorkspace(tx, target.userId))
    if (accountDeleted && subject.email)
      await queueRemovedEmail(tx, subject.email, workspaceId, { name: await removerLabel(tx, actor.actorId), role: 'admin' }, now)
    return { rows: { calls: forgotten.calls }, data: { accountDeleted, invitationsCanceled, subject } }
  },
}
