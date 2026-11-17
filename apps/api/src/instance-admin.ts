// Instance admin: the operator of the install. A property of the user, independent of workspace
// roles. Granted in the admin area, by the CLI (user:create --admin), or by INSTANCE_ADMIN_EMAILS (which
// also makes the first user of an install one, once their address is proven).
import { randomBytes } from 'node:crypto'
import { markPasskeySession } from './admin-second-factor.ts'
import { account, type Tx, user } from '@linedesk/db'
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import { APIError } from 'better-auth/api'
import { hashPassword } from 'better-auth/crypto'
import { insertAuthEvent } from './audit.ts'
import { db } from './db.ts'
import { keepImpersonationExpiry } from './impersonation-guard.ts'
import { issuePasskeyEnrolment } from './passkey-enrolment.ts'
import { NO_ACCOUNT, refuseClosedSignUp } from './signup-gate.ts'

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
  const admins = await db
    .select({ email: user.email })
    .from(user)
    .where(and(isInstanceAdminSql(), isNull(user.disabledAt)))
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
      // The endpoint's path says how the account is being made (signup-gate.ts: self-serve only by the email code).
      before: async (created: { email: string; emailVerified?: boolean }, ctx?: { path?: string } | null) => {
        await refuseClosedSignUp(db, created, ctx?.path ?? null)
        await refuseUnverifiedAdminAddress(db, created)
      },
      after: async (created: { id: string; email: string; emailVerified?: boolean }) => {
        await grantFirstUser(db, created)
        // Made through an invitation (signup-gate.ts): it joins the workspace in the same step. Loaded here, since
        // memberships.ts reaches back to this file.
        if (created.emailVerified) await joinOrUndo(created)
      },
    },
  },
  session: {
    create: {
      before: async (session: { userId: string; impersonatedBy?: string | null }, ctx?: unknown) => {
        const [account] = await db.select({ disabledAt: user.disabledAt }).from(user).where(eq(user.id, session.userId))
        if (account?.disabledAt)
          throw new APIError('FORBIDDEN', { code: 'ACCOUNT_DISABLED', message: 'This account is disabled.' })
        // An admin signing in as the user is not the user signing in.
        if (!session.impersonatedBy)
          await db.update(user).set({ lastSignInAt: new Date() }).where(eq(user.id, session.userId))
        // A passkey sign-in counts as the second factor the admin area needs (admin-second-factor.ts).
        return markPasskeySession(session, ctx)
      },
      // An account a server admin made for a workspace joins it at the first sign-in (memberships.ts, joinOnSignIn).
      // Each join and its `invitation_accepted` are saved together, in one transaction. A failure is logged and never
      // stops the sign-in: nothing was joined, the invitation stays and can still be joined by hand.
      after: async (session: {
        userId: string
        impersonatedBy?: string | null
        ipAddress?: string | null
        userAgent?: string | null
      }) => {
        if (session.impersonatedBy) return
        const { joinOnSignIn } = await import('./memberships.ts')
        try {
          await db.transaction(async tx => {
            for (const workspaceId of await joinOnSignIn(tx, session.userId))
              await insertAuthEvent(tx, {
                event: 'invitation_accepted',
                userId: session.userId,
                workspaceId,
                method: 'admin_created',
                ipAddress: session.ipAddress,
                userAgent: session.userAgent,
              })
          })
        } catch (err) {
          console.error('joining the workspaces of an admin-made account failed; nothing was joined', err)
        }
      },
    },
    update: {
      before: async (data: { expiresAt?: Date }, ctx: unknown) =>
        keepImpersonationExpiry(data, ctx as Parameters<typeof keepImpersonationExpiry>[1]),
    },
  },
}

/**
 * A new account joins the workspaces it was invited to. Better Auth runs this after its own transaction has saved the
 * user, so the join cannot share it; instead, an account that ends up in no workspace is deleted again, in the join's
 * transaction (or right after a join that failed): no account without a workspace stays behind (security review of
 * #734, finding 6). Never a server admin's (the first-run setup on an empty install has no workspace yet).
 */
export async function joinOrUndo(created: { id: string; email: string }) {
  const { joinInvitedWorkspaces } = await import('./memberships.ts')
  const { deleteAccountWithoutWorkspace } = await import('./workspace-delete.ts')
  const { maySignUpWithCode } = await import('./self-serve.ts')
  const { partnerInvitationFor } = await import('./partners.ts')
  // Each step is in the audit log, in the same transaction as the step: the joins, or the account removed again.
  const undo = async (tx: Tx) => {
    // Made by the sign-up page (self-serve.ts): it stays without a workspace until account.signUp makes one; the
    // daily sign-up sweep removes it when that never happens.
    if (await maySignUpWithCode(tx, created.email)) return false
    // Invited to a white-label partner's team (signup-gate.ts): it joins on the invitation page, signed in. The sign-up
    // sweep removes it when the invitation ends unused (signup-handlers.ts; security review of #1100, M-1).
    if (await partnerInvitationFor(tx, created.email)) return false
    const gone = await deleteAccountWithoutWorkspace(tx, created.id)
    if (gone) await insertAuthEvent(tx, { event: 'sign_up_undone', userId: created.id, email: created.email })
    return gone
  }
  let undone = false
  try {
    undone = await db.transaction(async tx => {
      for (const workspaceId of await joinInvitedWorkspaces(tx, created))
        await insertAuthEvent(tx, {
          event: 'invitation_accepted',
          userId: created.id,
          workspaceId,
          method: 'invitation',
        })
      return undo(tx)
    })
  } catch (err) {
    console.error('joining the invited workspaces of a new account failed; the account is removed again', err)
    await db.transaction(undo)
    throw err
  }
  // The invitation went away in between (revoked, the workspace disabled): as if there had been none.
  if (undone) throw new APIError('FORBIDDEN', { code: 'SIGNUP_CLOSED', message: NO_ACCOUNT })
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
