// No open sign-up (Janik, 2026-11-15): nobody creates an account on their own. Accounts come only from the first-run
// setup (setup.ts, or INSTANCE_ADMIN_EMAILS on an empty install), a workspace invitation (the account is made and
// joins the workspace in one step: joinInvitedWorkspaces), or a server admin (user.invite, workspace.create,
// user:create). Every way Better Auth creates a user (password sign-up, first email-code sign-in, first SSO sign-in)
// passes its `user.create` hook, so the gate sits there. Existing users sign in as before.
import { invitation, organization, type Tx, user } from '@linedesk/db'
import { APIError } from 'better-auth/api'
import { and, eq, gt, isNull, sql } from 'drizzle-orm'
import { envAdminEmails } from './instance-admin.ts'

/**
 * Whether a new user with this address may be created now: the install has no users yet and the address is listed in
 * INSTANCE_ADMIN_EMAILS, or a pending, unexpired workspace invitation exists for it and the address is proven (an
 * email code or a sign-in provider): a password sign-up does not prove it, so it never creates an account.
 */
export async function mayCreateUser(tx: Tx, email: string, verified: boolean): Promise<boolean> {
  if (!verified) return false
  const [anyone] = await tx.select({ id: user.id }).from(user).limit(1)
  // An empty install: only the operator's own address (INSTANCE_ADMIN_EMAILS).
  if (!anyone) return envAdminEmails().includes(email.toLowerCase())
  // Only an invitation the account can be joined to: a disabled workspace would leave an account without one.
  const [invited] = await tx
    .select({ id: invitation.id })
    .from(invitation)
    .innerJoin(organization, eq(organization.id, invitation.organizationId))
    .where(
      and(
        sql`lower(${invitation.email}) = ${email.toLowerCase()}`,
        eq(invitation.status, 'pending'),
        gt(invitation.expiresAt, new Date()),
        isNull(organization.disabledAt),
      ),
    )
    .limit(1)
  return Boolean(invited)
}

/** What someone without an account and without an invitation is told (sign-in page, provider sign-in). */
export const NO_ACCOUNT = 'No account for this email. Ask your workspace admin for an invitation.'

/**
 * Better Auth `user.create` hook: refuses a new user without an invitation. The code lets a provider sign-in (Google,
 * Microsoft, GitHub, OIDC) send the browser back to the sign-in page with `?error=SIGNUP_CLOSED` instead of answering
 * the callback with a bare 403.
 */
export async function refuseClosedSignUp(tx: Tx, created: { email: string; emailVerified?: boolean }) {
  if (!(await mayCreateUser(tx, created.email, created.emailVerified === true)))
    throw new APIError('FORBIDDEN', { code: 'SIGNUP_CLOSED', message: NO_ACCOUNT })
}

/** A sign-in code only goes out when it can sign someone in: to an account, or to an address that may create one. */
export async function maySendSignInCode(tx: Tx, email: string): Promise<boolean> {
  const [existing] = await tx
    .select({ id: user.id, disabledAt: user.disabledAt })
    .from(user)
    .where(sql`lower(${user.email}) = ${email.toLowerCase()}`)
    .limit(1)
  // A disabled account cannot sign in: no code for it (the answer stays the same, see sendSignInCode).
  if (existing?.disabledAt) return false
  if (existing) return true
  // A code proves the address once it is entered.
  return mayCreateUser(tx, email, true)
}
