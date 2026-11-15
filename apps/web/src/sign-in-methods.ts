// Which sign-in method this device used last, for the "Last used" badge and the sign-in page's first view. A per-device
// convenience only: storage may be missing or blocked (private window, cleared data), so every access is guarded.
import { markSignedIn } from './passkey-ask.ts'

export type SignInMethodId = 'email' | 'password' | string

const LAST_USED_KEY = 'linedesk.lastSignInMethod'

export function readLastUsedMethod(): SignInMethodId | null {
  try {
    return localStorage.getItem(LAST_USED_KEY)
  } catch {
    return null
  }
}

/** A sign-in with `method` on this device: remembered, and without a passkey the "Add a passkey" page is due (passkey-ask.ts). */
export function rememberSignInMethod(method: SignInMethodId) {
  markSignedIn(method)
  try {
    localStorage.setItem(LAST_USED_KEY, method)
  } catch {
    // Without storage the badge just does not show.
  }
}

/** How the sign-in page starts. `passkeyFirst`: "Sign in with passkey" on top; `emailOpen`: the email form already shown. */
export type SignInStart = { passkeyFirst: boolean; emailOpen: boolean }

/**
 * The passkey is the first and preferred way in, the email code the alternative (LIN-215). Only for signing in to an
 * existing account (a passkey makes no account) and only where the install and this browser can use passkeys: without
 * them the email form is the page. The email form starts open when this device last signed in with it or a password.
 */
export function signInStart(input: {
  passkeyOn: boolean
  supported: boolean
  /** Signing a signed-in member in again (the admin area): the passkey is offered inside the form instead. */
  reauth: boolean
  lastUsed: SignInMethodId | null
}): SignInStart {
  const passkeyFirst = input.passkeyOn && input.supported && !input.reauth
  return { passkeyFirst, emailOpen: !passkeyFirst || input.lastUsed === 'email' || input.lastUsed === 'password' }
}

/**
 * Whether a failed passkey request is one the person closed, that timed out or that found no passkey for this site
 * on the device (the browser's NotAllowedError, which on purpose does not say which), or that the page itself
 * cancelled: nothing went wrong, the email code is the way on. Anything else (a wrong site address, an authenticator
 * error, the server) is shown.
 */
export function passkeyRequestClosed(error: unknown): boolean {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined
  return code === 'ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY' || code === 'ERROR_CEREMONY_ABORTED'
}

const REDIRECT_KEY = 'linedesk.signInRedirect'

/**
 * A provider sign-in that leaves the page (the invitation page): which method, remembered only for this tab until it
 * comes back. `takeRedirectSignIn` then remembers it as a sign-in once there is a session, never before.
 */
export function startRedirectSignIn(method: SignInMethodId) {
  try {
    sessionStorage.setItem(REDIRECT_KEY, method)
  } catch {
    // Without storage the page after signing in does not know the method; nothing else depends on it.
  }
}

/** Back with a session: the provider sign-in started here counts as this device's sign-in (once). */
export function takeRedirectSignIn(signedIn: boolean) {
  let method: string | null = null
  try {
    method = sessionStorage.getItem(REDIRECT_KEY)
    sessionStorage.removeItem(REDIRECT_KEY)
  } catch {
    return
  }
  if (method && signedIn) rememberSignInMethod(method)
}
