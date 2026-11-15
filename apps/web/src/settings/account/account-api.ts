// The Account page's calls. Everything goes to Better Auth: its client, or the one server-only
// method (set a first password) through POST /v1/account/password.
import type { ChangedBy } from '@linedesk/actions'
import { auth, type AuthMethods, fetchAuthMethods, fetchMe, signedInAccount, signInWithPasskey } from '../../auth.ts'
import { refreshQuery } from '../../cachedQuery.ts'
import { forgetEnrolmentCode } from '../../enrolment-code.ts'
import { signOutAndForget } from '../../localData.ts'
import { authErrorMessage } from '../../sign-in-code.ts'
import { rememberSignInMethod } from '../../sign-in-methods.ts'
import { describeDevice, type LinkedAccount, type SessionRow } from './account-model.ts'

type Result<T> = { data: T | null; error: { message?: string; code?: string; status?: number } | null }

/** The server wants a recent sign-in before it does this; the page offers "Sign in again". */
export class SignInAgain extends Error {}

/**
 * The account has a passkey: changing its passkeys needs a session started by signing in with one
 * in the last 12 hours (apps/api/src/passkeys.ts). The page confirms in place (confirmWithPasskey).
 */
export class ConfirmWithPasskey extends SignInAgain {}
const PASSKEY_SIGN_IN = 'Confirm with one of your passkeys to do this.'

/** The browser offered another account's passkey and it was used: that session is gone, nothing is retried. */
export class PasskeyOfAnotherAccount extends Error {}
const OTHER_ACCOUNT = 'That passkey belongs to another account. You were signed out; sign in again.'
const RELOAD_AFTER_MS = 3000

/**
 * Signs in with one of the account's passkeys: a new session that may change its passkeys. Failing, it can be tried again.
 * The browser lets the member pick any passkey of this site: one of another account would switch the session to it,
 * so a different account afterwards signs out, reloads to the sign-in page and never lets the request run as it.
 */
export async function confirmWithPasskey() {
  const before = await signedInAccount()
  const result = await signInWithPasskey()
  if (result?.error) throw new ConfirmWithPasskey(authErrorMessage(result.error))
  if (before && (await signedInAccount()) !== before) {
    await signOutAndForget()
    setTimeout(() => window.location.reload(), RELOAD_AFTER_MS)
    throw new PasskeyOfAnotherAccount(OTHER_ACCOUNT)
  }
}

function unwrap<T>(result: Result<T>, fallback: string): T {
  if (result.error?.code === 'SESSION_NOT_FRESH') throw new SignInAgain('Sign in again to do this.')
  if (result.error?.code === 'PASSKEY_CONFIRMATION_REQUIRED') throw new ConfirmWithPasskey(PASSKEY_SIGN_IN)
  if (result.error || result.data === null) throw new Error(result.error?.message || fallback)
  return result.data
}

export type Account = {
  /** `locale`: the UI language chosen (null: Automatic; absent in what an older version remembered). */
  user: { name: string; email: string; emailVerified: boolean; locale?: string | null }
  accounts: LinkedAccount[]
  methods: AuthMethods
  /** The profile picture (Account settings › Profile), null without one (absent in what an older version remembered). */
  avatarUrl?: string | null
  /** An owner or admin changed the name or picture last (Workspace settings › Team › Edit); null when you did. */
  profileChangedBy?: ChangedBy | null
}

/** Cache keys (cachedQuery.ts). The account is kept across page loads; sessions and passkeys only in memory. */
export const ACCOUNT = 'account'
export const SESSIONS = 'account.sessions'
export const PASSKEYS = 'account.passkeys'
export const PASSKEY_ENROLMENT = 'account.passkeyEnrolment'

export async function loadAccount(): Promise<Account> {
  const [session, accounts, methods, me] = await Promise.all([
    auth.getSession(),
    auth.listAccounts(),
    fetchAuthMethods({ attempts: 3 }),
    fetchMe().catch(() => null),
  ])
  const current = unwrap(session, 'You are signed out.')
  return {
    user: {
      name: current.user.name,
      email: current.user.email,
      emailVerified: current.user.emailVerified,
      locale: current.user.locale ?? null,
    },
    accounts: unwrap(accounts, 'Could not load your sign-in methods.'),
    methods,
    avatarUrl: me?.avatarUrl ?? null,
    profileChangedBy: me?.profileChangedBy ?? null,
  }
}

// Better Auth lists sessions with their tokens, and signing one out needs its token. The tokens
// stay in this module, keyed by session id, and never reach the page's state.
let tokens = new Map<string, string>()

/** The member's sessions. Throws SignInAgain when this session is older than a day (Better Auth's rule). */
export async function loadSessions(): Promise<SessionRow[]> {
  const [current, sessions] = await Promise.all([auth.getSession(), auth.listSessions()])
  const list = unwrap(sessions, 'Could not load your sessions.')
  const currentToken = current.data?.session.token
  tokens = new Map(list.map(s => [s.id, s.token]))
  return list.map(s => ({
    id: s.id,
    device: describeDevice(s.userAgent),
    lastActive: new Date(s.updatedAt),
    current: s.token === currentToken,
  }))
}

export async function changeName(name: string) {
  unwrap(await auth.updateUser({ name }), 'Could not save your name.')
}

/** Changes the password and signs every other session out. */
export async function changePassword(currentPassword: string, newPassword: string) {
  unwrap(
    await auth.changePassword({ currentPassword, newPassword, revokeOtherSessions: true }),
    'Could not change your password.',
  )
}

/** For a member without a password. The server asks for a sign-in in the last few minutes. */
export async function setFirstPassword(newPassword: string) {
  const res = await fetch('/v1/account/password', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ newPassword }),
  })
  if (res.ok) return
  const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string }
  if (body.code === 'SIGN_IN_AGAIN') throw new SignInAgain(body.error ?? 'Sign in again to set a password.')
  throw new Error(body.error ?? 'Could not set your password.')
}

/**
 * Asks for a code at the new address (apps/api/src/email-change.ts). The answer is the same whether or not
 * the address can be used: one that has an account gets a notice instead of a code. While the current address
 * is confirmed and the session is no recent passkey sign-in, it must be proven first: the answer is then
 * `confirmCurrentEmail`, a code went to the current address, and asking again with that `otp` sends the
 * code to the new one.
 */
export async function requestEmailChange(newEmail: string, otp?: string): Promise<{ confirmCurrentEmail: boolean }> {
  const result = (await auth.$fetch('/email-otp/request-email-change', {
    method: 'POST',
    body: otp ? { newEmail, otp } : { newEmail },
  })) as Result<{ confirmCurrentEmail?: boolean }>
  emailChangeResult(result)
  return { confirmCurrentEmail: result.data?.confirmCurrentEmail === true }
}

/** Moves the account to the new address with its code; the other sessions are signed out. */
export async function changeEmail(newEmail: string, otp: string) {
  const result = (await auth.$fetch('/email-otp/change-email', {
    method: 'POST',
    body: { newEmail, otp },
  })) as Result<unknown>
  emailChangeResult(result)
}

function emailChangeResult(result: Result<unknown>) {
  if (!result.error) return
  if (result.error.code === 'SESSION_NOT_FRESH') throw new SignInAgain('Sign in again to change your email address.')
  if (result.error.code === 'PASSKEY_CONFIRMATION_REQUIRED') throw new ConfirmWithPasskey(PASSKEY_SIGN_IN)
  throw new Error(authErrorMessage(result.error))
}

export async function signOutSession(id: string) {
  const token = tokens.get(id)
  if (!token) throw new Error('That session is no longer there.')
  unwrap(await auth.revokeSession({ token }), 'Could not sign that session out.')
}

export async function signOutOtherSessions() {
  unwrap(await auth.revokeOtherSessions(), 'Could not sign the other sessions out.')
}

export type PasskeyRow = { id: string; name: string; added: Date | null }

/** The member's passkeys, newest first. A passkey without a name is called after its device type. */
export async function loadPasskeys(): Promise<PasskeyRow[]> {
  const list = unwrap(
    (await auth.$fetch('/passkey/list-user-passkeys', { method: 'GET' })) as Result<
      { id: string; name?: string | null; createdAt?: string | null; deviceType: string }[]
    >,
    'Could not load your passkeys.',
  )
  return list
    .map(p => ({
      id: p.id,
      name: p.name || (p.deviceType === 'multiDevice' ? 'Synced passkey' : 'Passkey on a device'),
      added: p.createdAt ? new Date(p.createdAt) : null,
    }))
    .sort((a, b) => (b.added?.getTime() ?? 0) - (a.added?.getTime() ?? 0))
}

/**
 * Asks the browser to make a passkey for this account. Better Auth wants a sign-in within the last day;
 * once the account has a passkey (or is an instance admin's), the API asks for more (apps/api/src/passkeys.ts).
 */
export async function addPasskey(name: string, enrolmentCode?: string) {
  // An instance admin's first passkey: the server checks the code where the passkey is stored.
  const headers = enrolmentCode ? { 'x-passkey-enrolment': enrolmentCode.trim() } : undefined
  const result = await auth.passkey.addPasskey({ name, ...(headers && { fetchOptions: { headers } }) })
  if (result && 'error' in result && result.error) {
    if ('code' in result.error && result.error.code === 'SESSION_NOT_FRESH')
      throw new SignInAgain('Sign in again to add a passkey.')
    if ('code' in result.error && result.error.code === 'PASSKEY_CONFIRMATION_REQUIRED')
      throw new ConfirmWithPasskey(PASSKEY_SIGN_IN)
    throw new Error(authErrorMessage(result.error))
  }
}

/**
 * Adds a passkey on this device, named after it: Account › Sign-in & security, the "Add a passkey" page after signing
 * in and the card in the app all use this. A remembered enrolment code is used up; the passkey list is read again.
 */
export async function addPasskeyForThisDevice(enrolmentCode?: string) {
  await addPasskey(describeDevice(navigator.userAgent), enrolmentCode)
  forgetEnrolmentCode()
  // This device signs in with it from now on: the sign-in page opens on the passkey, not the email form.
  rememberSignInMethod('passkey')
  await refreshQuery(PASSKEYS).catch(() => {})
}

/** Whether adding a passkey asks for an enrolment code: an instance admin without a passkey. */
export async function loadPasskeyEnrolment(): Promise<boolean> {
  return (await fetchMe())?.passkeyEnrolment ?? false
}

/** Removes a passkey; like adding one, it needs a recent sign-in (the API checks). */
export async function removePasskey(id: string) {
  unwrap(
    (await auth.$fetch('/passkey/delete-passkey', { method: 'POST', body: { id } })) as Result<unknown>,
    'Could not remove the passkey.',
  )
}
