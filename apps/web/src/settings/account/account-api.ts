// The Account page's calls. Everything goes to Better Auth: its client, or the one server-only
// method (set a first password) through POST /v1/account/password.
import { auth, type AuthMethods, fetchAuthMethods, fetchMe } from '../../auth.ts'
import { authErrorMessage } from '../../sign-in-code.ts'
import { describeDevice, type LinkedAccount, type SessionRow } from './account-model.ts'

type Result<T> = { data: T | null; error: { message?: string; code?: string; status?: number } | null }

/** The server wants a recent sign-in before it does this; the page offers "Sign in again". */
export class SignInAgain extends Error {}

/** The account has a passkey: changing its passkeys needs a session started by signing in with one. */
const PASSKEY_SIGN_IN = 'Sign in again with one of your passkeys to do this.'

function unwrap<T>(result: Result<T>, fallback: string): T {
  if (result.error?.code === 'SESSION_NOT_FRESH') throw new SignInAgain('Sign in again to do this.')
  if (result.error?.code === 'PASSKEY_CONFIRMATION_REQUIRED') throw new SignInAgain(PASSKEY_SIGN_IN)
  if (result.error || result.data === null) throw new Error(result.error?.message || fallback)
  return result.data
}

export type Account = { user: { name: string; email: string; emailVerified: boolean }; accounts: LinkedAccount[]; methods: AuthMethods }

/** Cache keys (cachedQuery.ts). The account is kept across page loads; sessions and passkeys only in memory. */
export const ACCOUNT = 'account'
export const SESSIONS = 'account.sessions'
export const PASSKEYS = 'account.passkeys'
export const PASSKEY_ENROLMENT = 'account.passkeyEnrolment'

export async function loadAccount(): Promise<Account> {
  const [session, accounts, methods] = await Promise.all([auth.getSession(), auth.listAccounts(), fetchAuthMethods({ attempts: 3 })])
  const current = unwrap(session, 'You are signed out.')
  return {
    user: { name: current.user.name, email: current.user.email, emailVerified: current.user.emailVerified },
    accounts: unwrap(accounts, 'Could not load your sign-in methods.'),
    methods,
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
  return list.map(s => ({ id: s.id, device: describeDevice(s.userAgent), lastActive: new Date(s.updatedAt), current: s.token === currentToken }))
}

export async function changeName(name: string) {
  unwrap(await auth.updateUser({ name }), 'Could not save your name.')
}

/** Changes the password and signs every other session out. */
export async function changePassword(currentPassword: string, newPassword: string) {
  unwrap(await auth.changePassword({ currentPassword, newPassword, revokeOtherSessions: true }), 'Could not change your password.')
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
    (await auth.$fetch('/passkey/list-user-passkeys', { method: 'GET' })) as Result<{ id: string; name?: string | null; createdAt?: string | null; deviceType: string }[]>,
    'Could not load your passkeys.',
  )
  return list
    .map(p => ({ id: p.id, name: p.name || (p.deviceType === 'multiDevice' ? 'Synced passkey' : 'Passkey on a device'), added: p.createdAt ? new Date(p.createdAt) : null }))
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
    if ('code' in result.error && result.error.code === 'SESSION_NOT_FRESH') throw new SignInAgain('Sign in again to add a passkey.')
    if ('code' in result.error && result.error.code === 'PASSKEY_CONFIRMATION_REQUIRED') throw new SignInAgain(PASSKEY_SIGN_IN)
    throw new Error(authErrorMessage(result.error))
  }
}

/** Whether adding a passkey asks for an enrolment code: an instance admin without a passkey. */
export async function loadPasskeyEnrolment(): Promise<boolean> {
  return (await fetchMe())?.passkeyEnrolment ?? false
}

/** Removes a passkey; like adding one, it needs a recent sign-in (the API checks). */
export async function removePasskey(id: string) {
  unwrap((await auth.$fetch('/passkey/delete-passkey', { method: 'POST', body: { id } })) as Result<unknown>, 'Could not remove the passkey.')
}
