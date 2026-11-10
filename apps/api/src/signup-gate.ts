// Closed sign-up: with AUTH_SIGNUP_ENABLED=false nobody creates an account on their own. Every way
// a user is created (password sign-up, first email-code sign-in, first SSO sign-in) passes the
// Better Auth `user.create` hook, so the gate sits there. Existing users sign in as before.
import { invitation, type Tx, user } from '@callfront/db'
import { APIError } from 'better-auth/api'
import { and, eq, gt, sql } from 'drizzle-orm'

export const signUpOpen = (env: Record<string, string | undefined> = process.env) => env.AUTH_SIGNUP_ENABLED !== 'false'

/**
 * Whether a new user with this address may be created now: sign-up is open, the install has no
 * users yet (the first one sets it up), or a pending, unexpired workspace invitation exists for it
 * and the address is proven (an email code or a sign-in provider): a password sign-up does not
 * prove it, so it cannot use someone else's invitation.
 */
export async function mayCreateUser(tx: Tx, email: string, verified: boolean): Promise<boolean> {
  if (signUpOpen()) return true
  const [anyone] = await tx.select({ id: user.id }).from(user).limit(1)
  if (!anyone) return true
  if (!verified) return false
  const [invited] = await tx
    .select({ id: invitation.id })
    .from(invitation)
    .where(
      and(
        sql`lower(${invitation.email}) = ${email.toLowerCase()}`,
        eq(invitation.status, 'pending'),
        gt(invitation.expiresAt, new Date()),
      ),
    )
    .limit(1)
  return Boolean(invited)
}

/** Better Auth `user.create` hook: refuses a new user while sign-up is closed. */
export async function refuseClosedSignUp(tx: Tx, created: { email: string; emailVerified?: boolean }) {
  if (!(await mayCreateUser(tx, created.email, created.emailVerified === true)))
    throw new APIError('FORBIDDEN', { message: 'Sign-up is closed on this server.' })
}

/** A sign-in code only goes out when it can sign someone in: to an account, or to an address that may create one. */
export async function maySendSignInCode(tx: Tx, email: string): Promise<boolean> {
  if (signUpOpen()) return true
  const [existing] = await tx
    .select({ id: user.id })
    .from(user)
    .where(sql`lower(${user.email}) = ${email.toLowerCase()}`)
    .limit(1)
  // A code proves the address once it is entered.
  return Boolean(existing) || mayCreateUser(tx, email, true)
}
