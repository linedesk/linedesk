// Team management: invitations, roles and removal, as registry handlers. Members and invitations
// are Better Auth's tables; accepting an invitation is Better Auth's endpoint (see auth.ts).
// Better Auth's own endpoints for inviting and changing members are switched off there, so these
// handlers are the only write path and the rules below always apply.
import { randomBytes } from 'node:crypto'
import { INVITATION_DAYS, type TeamData, type TeamInvitation, type TeamMember } from '@linedesk/actions'
import { invitation, member, organization, type Tx, user } from '@linedesk/db'
import { and, asc, eq, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import type { Actor } from './context.ts'
import { emailSender } from './email.ts'
import { type Handler, Reject } from './handler-context.ts'
import { NOT_WHILE_IMPERSONATING } from './impersonation-guard.ts'
import { createRateLimiter } from './rate-limit.ts'

const WEB_ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:5173'
const DAY_MS = 86_400_000

// Invitation emails go to any address, so a workspace can send a limited number: 30 an hour,
// and one address gets at most 3 an hour (from any workspace), so nobody is flooded.
const allowEmailFor = createRateLimiter({ max: 30, windowMs: 3_600_000 })
const allowEmailTo = createRateLimiter({ max: 3, windowMs: 3_600_000 })

/**
 * A name as it may appear in a plain-text email: one line, at most 60 characters, and nothing a
 * mail program would turn into a link (a workspace called "Pay at evil.example" could otherwise
 * phish the invitee). URL-like names are left out and the fallback is used.
 */
export function emailSafeName(name: string | null | undefined, fallback: string): string {
  const oneLine = (name ?? '').replace(/\s+/g, ' ').trim()
  const urlLike = /:\/\/|www\.|@|[\p{L}\p{N}-]\.[\p{L}\p{N}-]{2,}/iu
  if (!oneLine || urlLike.test(oneLine)) return fallback
  return oneLine.length > 60 ? `${oneLine.slice(0, 59)}…` : oneLine
}

/** Unguessable: the id is the secret in the invitation link. */
const newInvitationId = () => randomBytes(24).toString('base64url')
export const invitationLink = (id: string) => `${WEB_ORIGIN}/?invite=${encodeURIComponent(id)}`

function workspaceOf(actor: Actor) {
  if (!actor.workspaceId) throw new Reject('no workspace')
  return actor.workspaceId
}

/** The email names the member who sent the invitation (`inviterId`), also when someone else resends it. */
export async function sendInvitation(tx: Tx, invite: { id: string; email: string; organizationId: string; inviterId: string }) {
  if (emailSender.kind === 'none') throw new Reject('email is not set up, so invitations cannot be sent (set SMTP_URL)')
  if (!allowEmailFor(invite.organizationId)) throw new Reject('too many invitations in the last hour; try again later')
  // The same answer whether or not the address has an account anywhere.
  if (!allowEmailTo(invite.email.toLowerCase())) throw new Reject('too many invitations to this address in the last hour; try again later')
  const [ws] = await tx.select({ name: organization.name }).from(organization).where(eq(organization.id, invite.organizationId))
  const [inviter] = await tx.select({ name: user.name }).from(user).where(eq(user.id, invite.inviterId))
  const who = emailSafeName(inviter?.name, 'A teammate')
  const workspaceName = emailSafeName(ws?.name, 'their workspace')
  const text = `${who} invited you to join ${workspaceName} on Linedesk.\n\nOpen this link to accept:\n\n${invitationLink(invite.id)}\n\nThe link works for ${INVITATION_DAYS} days. Sign in or create your account with this email address (${invite.email}). If you did not expect this, you can ignore it.`
  try {
    await emailSender.send({ to: invite.email, subject: `Join ${emailSafeName(ws?.name, 'your team')} on Linedesk`, text })
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

async function loadMember(tx: Tx, workspaceId: string, memberId: string) {
  const [row] = await tx.select().from(member).where(and(eq(member.id, memberId), eq(member.organizationId, workspaceId)))
  if (!row) throw new Reject('member not found')
  return row
}

/**
 * Changing or removing an owner: only an owner may, and another owner must remain. Locks the
 * owner rows and reads the acting member's role from them, inside the transaction: two owners
 * who demote each other at the same moment cannot both succeed, and an owner demoted a moment
 * ago no longer counts as one.
 */
async function guardOwner(tx: Tx, actor: Actor, target: { role: string; organizationId: string; id: string }) {
  if (target.role !== 'owner') return
  const owners = await tx.select({ id: member.id, userId: member.userId }).from(member)
    .where(and(eq(member.organizationId, target.organizationId), eq(member.role, 'owner'))).for('update')
  if (!owners.some(o => o.userId === actor.actorId)) throw new Reject('only an owner can change or remove an owner')
  if (!owners.some(o => o.id !== target.id)) throw new Reject('the workspace needs an owner: this is the last one')
}

async function listTeam(tx: Tx, actor: Actor): Promise<TeamData> {
  const workspaceId = workspaceOf(actor)
  const members: TeamMember[] = (await tx
    .select({ memberId: member.id, userId: user.id, name: user.name, email: user.email, role: member.role, joinedAt: member.createdAt })
    .from(member).innerJoin(user, eq(user.id, member.userId))
    .where(eq(member.organizationId, workspaceId)).orderBy(asc(member.createdAt)))
    .map(m => ({ ...m, role: m.role as TeamMember['role'], joinedAt: m.joinedAt.toISOString() }))
  const canManage = actor.permissions.includes('team:write')
  // Invitees' addresses are for those who invite: a member sees the team, not who is invited.
  if (!canManage) return { members, invitations: [], canManage, me: actor.actorId }
  const inviter = alias(user, 'inviter')
  const now = Date.now()
  const invitations: TeamInvitation[] = (await tx
    .select({ invitationId: invitation.id, email: invitation.email, role: invitation.role, invitedBy: inviter.name, expiresAt: invitation.expiresAt })
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
    const [pending] = await tx.select({ id: invitation.id }).from(invitation)
      .where(and(eq(invitation.organizationId, workspaceId), eq(invitation.status, 'pending'), sql`lower(${invitation.email}) = ${input.email}`))
    if (pending) throw new Reject(`${input.email} is already invited; resend the invitation instead`)
    const [row] = await tx.insert(invitation).values({
      id: newInvitationId(), organizationId: workspaceId, email: input.email, role: input.role, status: 'pending',
      expiresAt: new Date(Date.parse(now) + INVITATION_DAYS * DAY_MS), createdAt: new Date(now), inviterId: actor.actorId,
    }).returning()
    await sendInvitation(tx, row!)
    return { rows: {}, data: { invitationId: row!.id } }
  },

  'team.resendInvite': async ({ tx, actor, now }, input: { invitationId: string }) => {
    const invite = await loadPendingInvitation(tx, workspaceOf(actor), input.invitationId)
    await tx.update(invitation).set({ expiresAt: new Date(Date.parse(now) + INVITATION_DAYS * DAY_MS) }).where(eq(invitation.id, invite.id))
    await sendInvitation(tx, invite)
    return { rows: {} }
  },

  'team.revokeInvite': async ({ tx, actor }, input: { invitationId: string }) => {
    const invite = await loadPendingInvitation(tx, workspaceOf(actor), input.invitationId)
    await tx.update(invitation).set({ status: 'canceled' }).where(eq(invitation.id, invite.id))
    return { rows: {} }
  },

  'team.setRole': async ({ tx, actor }, input: { memberId: string; role: string }) => {
    const target = await loadMember(tx, workspaceOf(actor), input.memberId)
    await guardOwner(tx, actor, target)
    await tx.update(member).set({ role: input.role }).where(eq(member.id, target.id))
    return { rows: {} }
  },

  'team.leave': async ({ tx, actor }) => {
    if (actor.impersonation) throw new Reject(NOT_WHILE_IMPERSONATING)
    const workspaceId = workspaceOf(actor)
    const [me] = await tx.select().from(member).where(and(eq(member.organizationId, workspaceId), eq(member.userId, actor.actorId)))
    if (!me) throw new Reject('member not found')
    if (me.role === 'owner') {
      // Locked, like guardOwner: two owners leaving at the same moment cannot both succeed.
      const owners = await tx.select({ id: member.id }).from(member)
        .where(and(eq(member.organizationId, workspaceId), eq(member.role, 'owner'))).for('update')
      if (!owners.some(o => o.id !== me.id)) throw new Reject('you are the last owner: make someone else owner first')
    }
    await tx.delete(member).where(eq(member.id, me.id))
    const [next] = await tx.select({ id: member.organizationId }).from(member)
      .where(eq(member.userId, actor.actorId)).orderBy(asc(member.createdAt)).limit(1)
    return { rows: {}, data: { nextWorkspaceId: next?.id ?? null } }
  },

  'team.removeMember': async ({ tx, actor }, input: { memberId: string }) => {
    const target = await loadMember(tx, workspaceOf(actor), input.memberId)
    await guardOwner(tx, actor, target)
    await tx.delete(member).where(eq(member.id, target.id))
    return { rows: {} }
  },
}
