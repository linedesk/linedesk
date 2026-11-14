// Memberships across workspaces (packages/actions/src/membership.ts): an invitee answers an
// invitation from inside the app, and an instance admin adds, changes and removes members of any
// workspace. A workspace's own owners and admins use team.* (team.ts).
import { INVITATION_DAYS, type MyInvitation } from '@linedesk/actions'
import { invitation, member, organization, type Tx, user } from '@linedesk/db'
import { and, asc, eq, gt, ne, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { invitationSubject, memberSubject } from './audit.ts'
import type { Actor } from './context.ts'
import { type Handler, Forbidden, Reject } from './handler-context.ts'
import { NOT_WHILE_IMPERSONATING } from './impersonation-guard.ts'
import { dropWorkspacePush } from './push.ts'
import { emailSender } from './email.ts'
import { addedNoticeEmail, emailSafeName, memberAddedByAdminEmail } from './emails/templates.ts'
import { insertInvitation, pendingInvitationTo, sendInvitation } from './team.ts'

const DAY_MS = 86_400_000
const newMemberId = () => crypto.randomUUID().replaceAll('-', '')

/** The signed-in person themselves: not an instance admin acting as them, and with a verified address. */
async function invitee(tx: Tx, actor: Actor) {
  if (actor.impersonation) throw new Forbidden(NOT_WHILE_IMPERSONATING)
  const [account] = await tx.select().from(user).where(eq(user.id, actor.actorId))
  if (!account) throw new Reject('user not found')
  return account
}

const sameEmail = (email: string) => sql`lower(${invitation.email}) = lower(${email})`

/** A pending invitation to this address. Someone else's invitation is "not found", like a missing one. */
async function myPendingInvitation(tx: Tx, email: string, invitationId: string) {
  const [row] = await tx.select().from(invitation)
    .where(and(eq(invitation.id, invitationId), eq(invitation.status, 'pending'), sameEmail(email))).for('update')
  if (!row) throw new Reject('invitation not found')
  return row
}

async function isMember(tx: Tx, workspaceId: string, userId: string) {
  const [row] = await tx.select({ id: member.id }).from(member)
    .where(and(eq(member.organizationId, workspaceId), eq(member.userId, userId)))
  return !!row
}

async function listMine(tx: Tx, actor: Actor, now: string): Promise<MyInvitation[]> {
  const account = await invitee(tx, actor)
  if (!account.emailVerified) return []
  const inviter = alias(user, 'inviter')
  const rows = await tx
    .select({
      invitationId: invitation.id, workspaceId: organization.id, workspaceName: organization.name,
      role: invitation.role, invitedBy: inviter.name, expiresAt: invitation.expiresAt,
    })
    .from(invitation)
    .innerJoin(organization, eq(organization.id, invitation.organizationId))
    .innerJoin(inviter, eq(inviter.id, invitation.inviterId))
    .where(and(
      eq(invitation.status, 'pending'), sameEmail(account.email), gt(invitation.expiresAt, new Date(now)),
      sql`not exists (select 1 from member m where m.organization_id = ${invitation.organizationId} and m.user_id = ${account.id})`,
    ))
    .orderBy(asc(invitation.createdAt))
  return rows.map(r => ({ ...r, role: r.role ?? 'member', expiresAt: r.expiresAt.toISOString() }))
}

async function loadMember(tx: Tx, memberId: string) {
  const [row] = await tx.select().from(member).where(eq(member.id, memberId))
  if (!row) throw new Reject('member not found')
  return row
}

/** An owner who stops being one (new role or removed) must leave another owner behind. Locks the owner rows. */
async function keepAnOwner(tx: Tx, target: { id: string; role: string; organizationId: string }) {
  if (target.role !== 'owner') return
  const others = await tx.select({ id: member.id }).from(member)
    .where(and(eq(member.organizationId, target.organizationId), eq(member.role, 'owner'), ne(member.id, target.id))).for('update')
  if (!others.length) throw new Reject('the workspace needs an owner: this is the last one')
}

/** Locked: an accept that lands at the same moment waits, and then this finds it no longer pending. */
async function loadPendingInvitation(tx: Tx, invitationId: string) {
  const [row] = await tx.select().from(invitation).where(and(eq(invitation.id, invitationId), eq(invitation.status, 'pending'))).for('update')
  if (!row) throw new Reject('invitation not found')
  return row
}

/** Adds a member; the unique (workspace, user) index turns a concurrent second add into a clear refusal. */
async function insertMember(tx: Tx, row: typeof member.$inferInsert, already: string) {
  try {
    await tx.insert(member).values(row)
  } catch (e) {
    const code = (e as { code?: string; cause?: { code?: string } }).code ?? (e as { cause?: { code?: string } }).cause?.code
    if (code === '23505') throw new Reject(already)
    throw e
  }
}

/** A workspace people can be added to: it exists and is not disabled. */
export async function openWorkspace(tx: Tx, workspaceId: string) {
  const [row] = await tx
    .select({ id: organization.id, name: organization.name, disabledAt: organization.disabledAt })
    .from(organization)
    .where(eq(organization.id, workspaceId))
  if (!row) throw new Reject('workspace not found')
  if (row.disabledAt) throw new Reject(`${row.name} is disabled: enable it first`)
  return { id: row.id, name: row.name }
}

async function isMemberByEmail(tx: Tx, workspaceId: string, email: string) {
  const [row] = await tx
    .select({ id: member.id })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(and(eq(member.organizationId, workspaceId), sql`lower(${user.email}) = ${email.toLowerCase()}`))
  return !!row
}

/**
 * An invitation from the instance admin to `email`, sent as "You were added to …". They join with its link (or in
 * the app) once their address is confirmed: an admin never gives an unconfirmed account a membership (account-linking.ts
 * resets call routing in workspaces such an account owns on its first confirmation).
 */
export async function inviteToWorkspace(
  tx: Tx,
  actor: Actor,
  email: string,
  workspace: { id: string; name: string },
  role: string,
  now: string,
) {
  // An invitation names the person who sent it; the command line is nobody.
  if (actor.actorId === 'cli')
    throw new Reject('the command line cannot add to a workspace: use Server admin › Users › Add user')
  if (await isMemberByEmail(tx, workspace.id, email))
    throw new Reject(`${email} is already a member of ${workspace.name}`)
  if (await pendingInvitationTo(tx, workspace.id, email))
    throw new Reject(`${email} is already invited to ${workspace.name}: resend the invitation on their page`)
  const invite = await insertInvitation(
    tx,
    { organizationId: workspace.id, email, role, inviterId: actor.actorId },
    now,
  )
  await sendInvitation(tx, invite, role)
}

/** How a notice names the instance admin: their name, else their address. */
async function adminLabel(tx: Tx, actor: Actor) {
  if (actor.actorId === 'cli') return 'The server operator'
  const [who] = await tx.select({ name: user.name, email: user.email }).from(user).where(eq(user.id, actor.actorId))
  return emailSafeName(who?.name || who?.email, 'An administrator')
}

/** Notices are best effort: a failure is logged and never undoes the change. */
async function sendNotice(to: string, email: { subject: string; html: string; text: string }) {
  if (emailSender.kind === 'none') return
  try {
    await emailSender.send({ to, ...email })
  } catch (err) {
    console.error('membership notice email failed', err)
  }
}

/**
 * After an instance admin added someone to a workspace or invited them (membership.add, user.invite): the workspace's
 * owners hear of it (they did not make the change; a detective control), and someone added directly gets a short
 * notice (no invitation to accept). Sent from the handler, before the transaction commits: the codebase has no
 * after-commit hook, and a notice about a change that then rolls back is harmless.
 */
export async function noticeAddedByAdmin(
  tx: Tx,
  actor: Actor,
  person: { email: string; name?: string | null },
  workspace: { id: string; name: string },
  role: string,
  how: 'added' | 'invited',
) {
  const admin = await adminLabel(tx, actor)
  const ws = emailSafeName(workspace.name, 'your workspace')
  const who = emailSafeName(person.name || person.email, person.email)
  if (how === 'added')
    await sendNotice(person.email, addedNoticeEmail({ admin, workspace: ws, workspaceId: workspace.id, role }))
  const owners = await tx
    .select({ email: user.email, id: user.id })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(and(eq(member.organizationId, workspace.id), eq(member.role, 'owner')))
  const notice = memberAddedByAdminEmail({
    admin,
    who,
    workspace: ws,
    workspaceId: workspace.id,
    role,
    pending: how === 'invited',
  })
  for (const owner of owners) {
    if (owner.id === actor.actorId || owner.email.toLowerCase() === person.email.toLowerCase()) continue
    await sendNotice(owner.email, notice)
  }
}

/**
 * Makes an existing account a member of the workspace with `role`, no email (membership.add, and user.invite for an
 * account whose address is confirmed). A pending invitation of theirs to the same workspace is answered by this.
 */
export async function addToWorkspace(
  tx: Tx,
  account: { id: string; email: string },
  workspace: { id: string; name: string },
  role: string,
  now: string,
): Promise<string> {
  const already = `${account.email} is already a member of ${workspace.name}`
  if (await isMember(tx, workspace.id, account.id)) throw new Reject(already)
  const id = newMemberId()
  await insertMember(tx, { id, organizationId: workspace.id, userId: account.id, role, createdAt: new Date(now) }, already)
  await tx.update(invitation).set({ status: 'canceled' })
    .where(and(eq(invitation.organizationId, workspace.id), eq(invitation.status, 'pending'), sameEmail(account.email)))
  return id
}

export const membershipHandlers: Record<string, Handler> = {
  'invitation.listMine': async ({ tx, actor, now }) => ({ rows: {}, data: { invitations: await listMine(tx, actor, now) } }),

  'invitation.accept': async ({ tx, actor, now }, input: { invitationId: string }) => {
    const account = await invitee(tx, actor)
    if (!account.emailVerified) throw new Reject('confirm your email address first')
    const invite = await myPendingInvitation(tx, account.email, input.invitationId)
    if (invite.expiresAt.getTime() < Date.parse(now)) throw new Reject('this invitation has expired; ask for a new one')
    const already = 'you are already a member of this workspace'
    if (await isMember(tx, invite.organizationId, account.id)) throw new Reject(already)
    await insertMember(tx, { id: newMemberId(), organizationId: invite.organizationId, userId: account.id, role: invite.role ?? 'member', createdAt: new Date(now) }, already)
    await tx.update(invitation).set({ status: 'accepted' }).where(and(eq(invitation.id, invite.id), eq(invitation.status, 'pending')))
    return { rows: {}, data: { workspaceId: invite.organizationId, subject: { email: account.email, workspaceId: invite.organizationId } } }
  },

  'invitation.decline': async ({ tx, actor }, input: { invitationId: string }) => {
    const account = await invitee(tx, actor)
    const invite = await myPendingInvitation(tx, account.email, input.invitationId)
    await tx.update(invitation).set({ status: 'rejected' }).where(and(eq(invitation.id, invite.id), eq(invitation.status, 'pending')))
    return { rows: {}, data: { subject: { email: account.email, workspaceId: invite.organizationId } } }
  },

  'membership.add': async ({ tx, actor, now }, input: { userId: string; workspaceId: string; role: string }) => {
    // Locked, so the same user cannot be added twice at the same moment.
    const [account] = await tx.select().from(user).where(eq(user.id, input.userId)).for('update')
    if (!account) throw new Reject('user not found')
    if (account.disabledAt) throw new Reject(`${account.email} is disabled: enable the account first`)
    const workspace = await openWorkspace(tx, input.workspaceId)
    const subject = { email: account.email, workspaceId: workspace.id }
    // An unconfirmed address gets an invitation and joins once it is proven (as with Add user).
    if (!account.emailVerified) {
      await inviteToWorkspace(tx, actor, account.email, workspace, input.role, now)
      await noticeAddedByAdmin(tx, actor, account, workspace, input.role, 'invited')
      return { rows: {}, data: { memberId: null, joined: 'invited', subject } }
    }
    const id = await addToWorkspace(tx, account, workspace, input.role, now)
    await noticeAddedByAdmin(tx, actor, account, workspace, input.role, 'added')
    return { rows: {}, data: { memberId: id, joined: 'added', subject } }
  },

  'membership.setRole': async ({ tx }, input: { memberId: string; role: string }) => {
    const target = await loadMember(tx, input.memberId)
    // Owner and admin manage the team and where calls go: only for a confirmed address (see inviteToWorkspace).
    if (input.role !== 'member') {
      const [account] = await tx
        .select({ emailVerified: user.emailVerified, email: user.email })
        .from(user)
        .where(eq(user.id, target.userId))
      if (!account?.emailVerified)
        throw new Reject(`${account?.email ?? 'they'} must confirm their email address before they can be ${input.role}`)
    }
    if (input.role !== 'owner') await keepAnOwner(tx, target)
    await tx.update(member).set({ role: input.role }).where(eq(member.id, target.id))
    return { rows: {}, data: { subject: await memberSubject(tx, target.userId, target.organizationId) } }
  },

  'membership.remove': async ({ tx }, input: { memberId: string }) => {
    const target = await loadMember(tx, input.memberId)
    await keepAnOwner(tx, target)
    await tx.delete(member).where(eq(member.id, target.id))
    await dropWorkspacePush(tx, target.organizationId, target.userId)
    return { rows: {}, data: { subject: await memberSubject(tx, target.userId, target.organizationId) } }
  },

  'invitation.revoke': async ({ tx }, input: { invitationId: string }) => {
    const invite = await loadPendingInvitation(tx, input.invitationId)
    await tx.update(invitation).set({ status: 'canceled' }).where(and(eq(invitation.id, invite.id), eq(invitation.status, 'pending')))
    return { rows: {}, data: { subject: invitationSubject(invite) } }
  },

  'invitation.resend': async ({ tx, now }, input: { invitationId: string }) => {
    const invite = await loadPendingInvitation(tx, input.invitationId)
    await tx.update(invitation).set({ expiresAt: new Date(Date.parse(now) + INVITATION_DAYS * DAY_MS) })
      .where(and(eq(invitation.id, invite.id), eq(invitation.status, 'pending')))
    await sendInvitation(tx, invite)
    return { rows: {}, data: { subject: invitationSubject(invite) } }
  },
}
