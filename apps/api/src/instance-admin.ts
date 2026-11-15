// Instance admin: the operator of the install. A property of the user, independent of workspace
// roles. Granted in the admin area, by the CLI (user:create --admin), or by INSTANCE_ADMIN_EMAILS (which
// also makes the first user of an install one, once their address is proven).
import { randomBytes } from 'node:crypto'
import { markPasskeySession } from './admin-second-factor.ts'
import { account, type Tx, user } from '@linedesk/db'
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import { APIError } from 'better-auth/api'
import { hashPassword } from 'better-auth/crypto'
import { db } from './db.ts'
import { keepImpersonationExpiry } from './impersonation-guard.ts'
import { issuePasskeyEnrolment } from './passkey-enrolment.ts'
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

/** Every enabled instance admin (id and address), oldest first. */
export async function enabledInstanceAdmins(): Promise<{ id: string; email: string }[]> {
  return db
    .select({ id: user.id, email: user.email })
    .from(user)
    .where(and(isInstanceAdminSql(), isNull(user.disabledAt)))
    .orderBy(user.createdAt)
}

/** The addresses of every enabled instance admin: who is told about admin sign-ins and changes (admin-alerts.ts). */
export async function instanceAdminEmails(): Promise<string[]> {
  const admins = await db.select({ email: user.email }).from(user).where(and(isInstanceAdminSql(), isNull(user.disabledAt)))
  return admins.map(admin => admin.email)
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

/**
 * The first user of an install becomes its instance admin only when INSTANCE_ADMIN_EMAILS lists their
 * address and it is proven (an email code or a sign-in provider). Otherwise whoever reaches a fresh
 * install first would own it. Without the variable, the operator makes the first admin with the CLI
 * (`user:create --admin`) or sets INSTANCE_ADMIN_EMAILS. Two sign-ups at the very same moment on an
 * empty install can both miss it; grant it then in the database.
 */
export async function grantFirstUser(tx: Tx, created: { id: string; email: string; emailVerified?: boolean }) {
  if (!created.emailVerified || !envAdminEmails().includes(created.email.toLowerCase())) return
  await tx
    .update(user)
    .set({ instanceAdmin: true })
    .where(and(eq(user.id, created.id), sql`not exists (select 1 from ${user} other where other.id <> ${created.id})`))
}

/**
 * Nobody may create an account for a listed address without proving it: a password sign-up is
 * refused. Otherwise someone could register the operator's address first; once the operator
 * verifies it (an email link marks the existing account verified), that account, with the
 * other person's password and sessions, would be an instance admin. The first user too.
 */
export async function refuseUnverifiedAdminAddress(_tx: Tx, created: { email: string; emailVerified?: boolean }) {
  if (created.emailVerified || !envAdminEmails().includes(created.email.toLowerCase())) return
  throw new APIError('FORBIDDEN', {
    code: 'ADDRESS_RESERVED',
    message: 'This address is reserved for an administrator. Sign in with an email code or a sign-in provider.',
  })
}

/** Better Auth database hooks: first user, no sign-in for disabled users, last sign-in time. */
export const instanceAdminHooks = {
  user: {
    create: {
      before: async (created: { email: string; emailVerified?: boolean }) => {
        await refuseClosedSignUp(db, created)
        await refuseUnverifiedAdminAddress(db, created)
      },
      after: async (created: { id: string; email: string; emailVerified?: boolean }) => {
        await grantFirstUser(db, created)
      },
    },
  },
  session: {
    create: {
      before: async (session: { userId: string; impersonatedBy?: string | null }, ctx?: unknown) => {
        const [account] = await db.select({ disabledAt: user.disabledAt }).from(user).where(eq(user.id, session.userId))
        if (account?.disabledAt) throw new APIError('FORBIDDEN', { code: 'ACCOUNT_DISABLED', message: 'This account is disabled.' })
        // An admin signing in as the user is not the user signing in.
        if (!session.impersonatedBy)
          await db.update(user).set({ lastSignInAt: new Date() }).where(eq(user.id, session.userId))
        // A passkey sign-in counts as the second factor the admin area needs (admin-second-factor.ts).
        return markPasskeySession(session, ctx)
      },
    },
    update: {
      before: async (data: { expiresAt?: Date }, ctx: unknown) =>
        keepImpersonationExpiry(data, ctx as Parameters<typeof keepImpersonationExpiry>[1]),
    },
  },
}

const newId = () => crypto.randomUUID().replaceAll('-', '')

/**
 * `user:create --admin` on an install without email delivery (no SMTP_URL): nobody could get a
 * sign-in code, so the operator gets a one-time password to hand over instead, and a passkey
 * enrolment code. The address counts as proven: the operator, with shell access, vouches for it.
 * The person signs in with the password and changes it under Account.
 */
export async function createAdminWithPassword(input: { email: string; name: string }) {
  const email = input.email.trim().toLowerCase()
  const password = randomBytes(18).toString('base64url')
  const hashed = await hashPassword(password)
  return db.transaction(async tx => {
    const [taken] = await tx.select({ id: user.id }).from(user).where(sql`lower(${user.email}) = ${email}`)
    if (taken) throw new Error(`${email} already has an account`)
    const id = newId()
    await tx.insert(user).values({ id, name: input.name, email, emailVerified: true, instanceAdmin: true })
    await tx
      .insert(account)
      .values({ id: newId(), accountId: id, providerId: 'credential', userId: id, password: hashed })
    return { userId: id, email, password, ...(await issuePasskeyEnrolment(tx, id)) }
  })
}
