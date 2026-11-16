// No open sign-up (Janik, 2026-11-15): nobody creates an account on their own. Accounts come only from the first-run
// setup (setup.ts, or INSTANCE_ADMIN_EMAILS on an empty install), a workspace invitation (the account is made and
// joins the workspace in one step: joinInvitedWorkspaces), or a server admin (user.invite, workspace.create,
// user:create). Every way Better Auth creates a user (password sign-up, first email-code sign-in, first SSO sign-in)
// passes its `user.create` hook, so the gate sits there. Existing users sign in as before.
// One more way in on Linedesk Cloud (docs/billing.md §3.1, decision 1): self-serve sign-up, only while billing runs
// through Stripe and an instance admin opened it, and only for an address that asked for a code on the sign-up page.
import { invitation, organization, type Tx, user } from '@linedesk/db'
import { AsyncLocalStorage } from 'node:async_hooks'
import { APIError } from 'better-auth/api'
import { and, eq, gt, isNull, sql } from 'drizzle-orm'
import { envAdminEmails } from './instance-admin.ts'

/**
 * Whether a new user with this address may be created now: the install has no users yet and the address is listed in
 * INSTANCE_ADMIN_EMAILS, or a pending, unexpired workspace invitation exists for it and the address is proven (an
 * email code or a sign-in provider): a password sign-up does not prove it, so it never creates an account. Or
 * self-serve sign-up is open (billing in effect through Stripe, `signup.selfServe` on) and this address asked for a
 * code on the sign-up page in the last 15 minutes (self-serve.ts `maySignUpWithCode`); a verified address only, and only
 * where `selfServe` says the request may use it: entering the sign-up code, and sending it from the sign-up page.
 */
export async function mayCreateUser(
  tx: Tx,
  email: string,
  verified: boolean,
  { selfServe }: { selfServe: boolean } = { selfServe: false },
): Promise<boolean> {
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
  if (invited) return true
  if (!selfServe) return false
  // Loaded here: self-serve.ts reaches billing and the job queue, which must not load while auth.ts does.
  const { maySignUpWithCode } = await import('./self-serve.ts')
  return maySignUpWithCode(tx, email)
}

/** What someone without an account and without an invitation is told (sign-in page, provider sign-in). */
export const NO_ACCOUNT = 'No account for this email. Ask your workspace admin for an invitation.'

/** The Better Auth endpoint that signs in with an email code: the only one that creates a self-serve account. */
export const EMAIL_CODE_SIGN_IN_PATH = '/sign-in/email-otp'

/**
 * Better Auth `user.create` hook: refuses a new user without an invitation. The code lets a provider sign-in (Google,
 * Microsoft, GitHub, OIDC) send the browser back to the sign-in page with `?error=SIGNUP_CLOSED` instead of answering
 * the callback with a bare 403. A self-serve account is made only by entering the email code (`path`), never by a
 * provider sign-in or another endpoint in the sign-up window (security review F4 of #960).
 */
export async function refuseClosedSignUp(
  tx: Tx,
  created: { email: string; emailVerified?: boolean },
  path: string | null = null,
) {
  if (!(await mayCreateUser(tx, created.email, created.emailVerified === true, { selfServe: path === EMAIL_CODE_SIGN_IN_PATH })))
    throw new APIError('FORBIDDEN', { code: 'SIGNUP_CLOSED', message: NO_ACCOUNT })
}

/** Set while POST /v1/signup/code sends its code (app.ts): the one way a code reaches an address without an account. */
const signupPageSend = new AsyncLocalStorage<true>()
/** Runs `send` as the sign-up page's own code send (see maySendSignInCode). */
export const fromSignupPage = <T>(send: () => Promise<T>): Promise<T> => signupPageSend.run(true, send)

/**
 * A sign-in code only goes out when it can sign someone in: to an account, or to an address that may create one. An
 * address that may create one only through self-serve sign-up gets its code only from the sign-up page, which counts it
 * against the sign-up limits and the bot check; the normal sign-in page sends it nothing, also in the 15 minutes after
 * (security review F4 of #960: no mail amplifier around those limits).
 */
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
  return mayCreateUser(tx, email, true, { selfServe: signupPageSend.getStore() === true })
}
