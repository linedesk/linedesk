// Instance admin: the operator of the install. A property of the user, independent of workspace
// roles. Granted to the first user, in the admin area, or by INSTANCE_ADMIN_EMAILS.
import { markPasskeySession } from './admin-second-factor.ts'
import { type Tx, user } from '@linedesk/db'
import { and, eq, inArray, or, sql } from 'drizzle-orm'
import { APIError } from 'better-auth/api'
import { db } from './db.ts'
import { keepImpersonationExpiry } from './impersonation-guard.ts'
import { refuseClosedSignUp } from './signup-gate.ts'

type Account = { email: string; emailVerified: boolean; instanceAdmin: boolean }

/** Addresses from INSTANCE_ADMIN_EMAILS (comma-separated), lower case. */
export const envAdminEmails = (env: Record<string, string | undefined> = process.env) =>
  (env.INSTANCE_ADMIN_EMAILS ?? '')
    .split(',')
    .map(email => email.trim().toLowerCase())
    .filter(Boolean)

/**
 * Applies to accounts that already exist as well, once their address is verified (email link or a
 * sign-in provider). An unverified address does not count: anyone can sign up with any address.
 */
export const isEnvAdmin = (account: Pick<Account, 'email' | 'emailVerified'>) =>
  account.emailVerified && envAdminEmails().includes(account.email.toLowerCase())

export const isInstanceAdmin = (account: Account) => account.instanceAdmin || isEnvAdmin(account)

/** SQL form of `isInstanceAdmin`. */
function isInstanceAdminSql() {
  const emails = envAdminEmails()
  if (!emails.length) return eq(user.instanceAdmin, true)
  return or(eq(user.instanceAdmin, true), and(eq(user.emailVerified, true), inArray(sql`lower(${user.email})`, emails)))
}

/**
 * True when an enabled instance admin other than `userId` exists. Locks the admin rows, so two
 * admins who remove each other at the same moment cannot both succeed.
 */
export async function anotherAdminRemains(tx: Tx, userId: string): Promise<boolean> {
  const admins = await tx
    .select({ id: user.id, disabledAt: user.disabledAt })
    .from(user)
    .where(isInstanceAdminSql())
    .orderBy(user.id)
    .for('update')
  return admins.some(admin => admin.id !== userId && !admin.disabledAt)
}

/** The first user of an install becomes its instance admin. Two sign-ups at the very same moment on an empty install can both miss it; grant it then in the database. */
export async function grantFirstUser(tx: Tx, userId: string) {
  await tx
    .update(user)
    .set({ instanceAdmin: true })
    .where(and(eq(user.id, userId), sql`not exists (select 1 from ${user} other where other.id <> ${userId})`))
}

/**
 * Nobody may create an account for a listed address without proving it: a password sign-up is
 * refused. Otherwise someone could register the operator's address first; once the operator
 * verifies it (an email link marks the existing account verified), that account, with the
 * other person's password and sessions, would be an instance admin. The first user is exempt.
 */
export async function refuseUnverifiedAdminAddress(tx: Tx, created: { email: string; emailVerified?: boolean }) {
  if (created.emailVerified || !envAdminEmails().includes(created.email.toLowerCase())) return
  const [anyone] = await tx.select({ id: user.id }).from(user).limit(1)
  if (anyone) {
    throw new APIError('FORBIDDEN', {
      message: 'This address is reserved for an administrator. Sign up with an email link or a sign-in provider.',
    })
  }
}

/** Better Auth database hooks: first user, no sign-in for disabled users, last sign-in time. */
export const instanceAdminHooks = {
  user: {
    create: {
      before: async (created: { email: string; emailVerified?: boolean }) => {
        await refuseClosedSignUp(db, created)
        await refuseUnverifiedAdminAddress(db, created)
      },
      after: async (created: { id: string }) => {
        await grantFirstUser(db, created.id)
      },
    },
  },
  session: {
    create: {
      before: async (session: { userId: string; impersonatedBy?: string | null }, ctx?: unknown) => {
        const [account] = await db.select({ disabledAt: user.disabledAt }).from(user).where(eq(user.id, session.userId))
        if (account?.disabledAt) throw new APIError('FORBIDDEN', { message: 'This account is disabled.' })
        // An admin signing in as the user is not the user signing in.
        if (!session.impersonatedBy) await db.update(user).set({ lastSignInAt: new Date() }).where(eq(user.id, session.userId))
        // A passkey sign-in counts as the second factor the admin area needs (admin-second-factor.ts).
        return markPasskeySession(session, ctx)
      },
    },
    update: { before: async (data: { expiresAt?: Date }, ctx: unknown) => keepImpersonationExpiry(data, ctx as Parameters<typeof keepImpersonationExpiry>[1]) },
  },
}
