// Joining a workspace by invitation: what the invitation link shows before sign-in, and the
// checks Better Auth runs when an invitation is accepted (wired in auth.ts).
import type { InvitationPreview } from '@linedesk/actions'
import { invitation, member, organization, user } from '@linedesk/db'
import { APIError } from 'better-auth/api'
import { and, eq } from 'drizzle-orm'
import { db } from './db.ts'
import { emailSender } from './email.ts'

/**
 * Public: the invitation page asks whom the link is for before anyone signs in. The id is the
 * secret from the email, so whoever has it may see the address and the workspace name.
 */
export async function previewInvitation(id: string): Promise<InvitationPreview> {
  const [row] = await db
    .select({ email: invitation.email, role: invitation.role, status: invitation.status, expiresAt: invitation.expiresAt, workspaceName: organization.name, invitedBy: user.name })
    .from(invitation)
    .innerJoin(organization, eq(organization.id, invitation.organizationId))
    .innerJoin(user, eq(user.id, invitation.inviterId))
    .where(eq(invitation.id, id))
  if (row?.status !== 'pending') return { status: 'gone' }
  if (row.expiresAt.getTime() < Date.now()) return { status: 'expired' }
  return { status: 'pending', email: row.email, workspaceName: row.workspaceName, invitedBy: row.invitedBy, role: row.role ?? 'member' }
}

/** Better Auth hook before an invitation is accepted. It has already checked that the signed-in email matches and is verified. */
export async function refuseExistingMember({ invitation: invite, user: account }: { invitation: { organizationId: string }; user: { id: string } }) {
  const [existing] = await db.select({ id: member.id }).from(member)
    .where(and(eq(member.organizationId, invite.organizationId), eq(member.userId, account.id)))
  if (existing) throw new APIError('BAD_REQUEST', { message: 'You are already a member of this workspace.' })
}

/**
 * Better Auth's email verification. Accepting an invitation needs a verified address; someone
 * who signed up with a password confirms theirs with this link (the invitation page asks for it).
 */
export async function sendVerificationEmail({ user: account, url }: { user: { email: string }; url: string }) {
  const text = `Open this link to confirm your email address for Linedesk:\n\n${url}\n\nIf you did not ask for it, you can ignore this email.`
  try {
    await emailSender.send({ to: account.email, subject: 'Confirm your email for Linedesk', text })
  } catch (err) {
    console.error('verification email failed', err)
    throw new APIError('INTERNAL_SERVER_ERROR', { message: 'Could not send the email. Try again in a moment.' })
  }
}
