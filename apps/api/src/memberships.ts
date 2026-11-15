// Memberships across workspaces (packages/actions/src/membership.ts): an invitee answers an
// invitation from inside the app, and an instance admin adds, changes and removes members of any
// workspace. A workspace's own owners and admins use team.* (team.ts).
import { INVITATION_DAYS, type MyInvitation } from '@linedesk/actions'
import { invitation, member, organization, type Tx, user } from '@linedesk/db'
import { and, asc, eq, gt, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { invitationSubject, memberSubject } from './audit.ts'
import type { Actor } from './context.ts'
import { type Handler, Forbidden, Reject } from './handler-context.ts'
import { NOT_WHILE_IMPERSONATING } from './impersonation-guard.ts'
import { dropWorkspacePush } from './push.ts'
import { emailSender } from './email.ts'
import { addedNoticeEmail, emailSafeName, memberAddedByAdminEmail } from './emails/templates.ts'
import { insertInvitation, makeOwner, pendingInvitationTo, sendInvitation } from './team.ts'
import { deleteAccountWithoutWorkspace } from './workspace-delete.ts'

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

/** Locked, like team.ts: a hand-over at the same moment waits, and the owner check then sees the new role. */
async function loadMember(tx: Tx, memberId: string) {
  const [row] = await tx.select().from(member).where(eq(member.id, memberId)).for('update')
  if (!row) throw new Reject('member not found')
  return row
}

/** The owner stays until someone else is made owner (exactly one per workspace): never demoted or removed directly. */
function keepTheOwner(target: { role: string }) {
  if (target.role === 'owner') throw new Reject('the workspace needs its owner: make someone else the owner first')
}

/**
 * Whether the workspace can get an owner by an add or an invitation: it has none and no owner invitation is pending.
 * Locks the owner row, so two adds at the same moment cannot both pass (the unique owner index is the backstop).
 */
async function ownerSlotFree(tx: Tx, workspaceId: string): Promise<boolean> {
  const [owner] = await tx.select({ id: member.id }).from(member)
    .where(and(eq(member.organizationId, workspaceId), eq(member.role, 'owner'))).for('update')
  if (owner) return false
  const [pending] = await tx.select({ id: invitation.id }).from(invitation)
    .where(and(eq(invitation.organizationId, workspaceId), eq(invitation.status, 'pending'), eq(invitation.role, 'owner')))
  return !pending
}

async function refuseSecondOwner(tx: Tx, workspace: { id: string; name: string }, role: string) {
  if (role === 'owner' && !(await ownerSlotFree(tx, workspace.id)))
    throw new Reject(
      `${workspace.name} has an owner already: add them as admin, then make them the owner on the workspace's page (the owner becomes an admin)`,
    )
}

/**
 * The role an accepted invitation gives: owner only while the workspace still has no owner (an owner made meanwhile
 * keeps it; the invitee joins as admin). For both ways to accept: invitation.accept and Better Auth's endpoint.
 */
export async function roleOnAccept(tx: Tx, invite: { organizationId: string; role: string | null }): Promise<string> {
  const role = invite.role ?? 'member'
  if (role !== 'owner') return role
  const [owner] = await tx.select({ id: member.id }).from(member)
    .where(and(eq(member.organizationId, invite.organizationId), eq(member.role, 'owner'))).for('update')
  return owner ? 'admin' : 'owner'
}

/**
 * A new account made through an invitation (signup-gate.ts: only a proven address with a pending invitation gets one)
 * joins every workspace it is invited to, in the same step: there is no account without a workspace unless someone
 * chose to keep it. Workspaces that are disabled meanwhile, or that it is in already, are skipped. Each join counts as
 * accepting that invitation (owner only while the workspace has none, like invitation.accept).
 */
export async function joinInvitedWorkspaces(
  tx: Tx,
  account: { id: string; email: string },
  now = new Date(),
  only: { joinOnSignIn?: boolean } = {},
) {
  const invites = await tx
    .select({ id: invitation.id, organizationId: invitation.organizationId, role: invitation.role })
    .from(invitation)
    .innerJoin(organization, eq(organization.id, invitation.organizationId))
    .where(
      and(
        sameEmail(account.email),
        eq(invitation.status, 'pending'),
        gt(invitation.expiresAt, now),
        sql`${organization.disabledAt} is null`,
        only.joinOnSignIn ? eq(invitation.joinOnSignIn, true) : undefined,
      ),
    )
    .orderBy(asc(invitation.createdAt))
    .for('update', { of: invitation })
  const joined: string[] = []
  for (const invite of invites) {
    if (await isMember(tx, invite.organizationId, account.id)) continue
    const role = await roleOnAccept(tx, invite)
    await tx.insert(member).values({ id: newMemberId(), organizationId: invite.organizationId, userId: account.id, role, createdAt: now })
    await tx.update(invitation).set({ status: 'accepted' }).where(and(eq(invitation.id, invite.id), eq(invitation.status, 'pending')))
    joined.push(invite.organizationId)
  }
  return joined
}

/**
 * At a sign-in (instance-admin.ts, session.create): the invitations a server admin made together with this account
 * (Add user, Create workspace) join at once, no Join click. Only to the exact invited address, once it is proven
 * (emailVerified), not for a disabled account; each invitation once (accepted), never after it expired. Normal
 * invitations to existing accounts keep the Join step. The workspaces joined.
 */
export async function joinOnSignIn(tx: Tx, userId: string, now = new Date()) {
  const [account] = await tx
    .select({ id: user.id, email: user.email, emailVerified: user.emailVerified, disabledAt: user.disabledAt })
    .from(user)
    .where(eq(user.id, userId))
  if (!account?.emailVerified || account.disabledAt) return []
  return joinInvitedWorkspaces(tx, account, now, { joinOnSignIn: true })
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
  /** The account was made with this invitation by a server admin: it joins at the first sign-in (joinOnSignIn). */
  joinOnSignIn = false,
) {
  // An invitation names the person who sent it; the command line is nobody.
  if (actor.actorId === 'cli')
    throw new Reject('the command line cannot add to a workspace: use Server admin › Users › Add user')
  if (await isMemberByEmail(tx, workspace.id, email))
    throw new Reject(`${email} is already a member of ${workspace.name}`)
  if (await pendingInvitationTo(tx, workspace.id, email))
    throw new Reject(`${email} is already invited to ${workspace.name}: resend the invitation on their page`)
  await refuseSecondOwner(tx, workspace, role)
  const invite = await insertInvitation(
    tx,
    { organizationId: workspace.id, email, role, inviterId: actor.actorId, joinOnSignIn },
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
  await refuseSecondOwner(tx, workspace, role)
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
    const role = await roleOnAccept(tx, invite)
    await insertMember(tx, { id: newMemberId(), organizationId: invite.organizationId, userId: account.id, role, createdAt: new Date(now) }, already)
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
    if (input.role === 'owner') {
      // Hands the workspace over: the owner before becomes an admin (locked, so two at once cannot both win).
      const [owner] = await tx.select({ id: member.id }).from(member)
        .where(and(eq(member.organizationId, target.organizationId), eq(member.role, 'owner'))).for('update')
      if (owner?.id !== target.id) await makeOwner(tx, target, owner?.id ?? null)
    } else {
      keepTheOwner(target)
      await tx.update(member).set({ role: input.role }).where(eq(member.id, target.id))
    }
    return { rows: {}, data: { subject: await memberSubject(tx, target.userId, target.organizationId) } }
  },

  'membership.remove': async ({ tx }, input: { memberId: string; keepAccount?: boolean }) => {
    const target = await loadMember(tx, input.memberId)
    keepTheOwner(target)
    const subject = await memberSubject(tx, target.userId, target.organizationId)
    await tx.delete(member).where(eq(member.id, target.id))
    await dropWorkspacePush(tx, target.organizationId, target.userId)
    // Their last workspace: the account goes too, unless kept (workspace-delete.ts).
    const accountDeleted = !input.keepAccount && (await deleteAccountWithoutWorkspace(tx, target.userId))
    return { rows: {}, data: { accountDeleted, subject } }
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
