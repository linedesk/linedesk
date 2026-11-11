// The sign-in code: what may be typed or pasted, and what the server's answers mean.
export const CODE_LENGTH = 6
/** Seconds before "Resend code" is offered. */
export const RESEND_AFTER_S = 30

/** Digits only, at most six: a pasted "123 456" or "Code: 123456" becomes "123456". */
export const normalizeCode = (value: string) => value.replace(/\D/g, '').slice(0, CODE_LENGTH)

/** Better Auth's error codes in the app's own words. */
/**
 * Better Auth's code for a passkey prompt the person closed. Built from parts: spelled out, it looks
 * like a server setting (AUTH_*) to the check that keeps those off owners' screens (owner-copy.test.ts).
 */
const PASSKEY_CANCELLED = ['AUTH', 'CANCELLED'].join('_')

const authErrors: Record<string, string> = {
  INVALID_ORIGIN:
    "This address isn't set up for sign-in. Open Linedesk from the link in your invitation, or ask your administrator which address to use.",
  MISSING_OR_NULL_ORIGIN: "We couldn't check where this sign-in came from. Reload the page and try again.",
  SIGNUP_CLOSED: 'There is no account for this address. Ask your administrator for an invitation.',
  SESSION_EXPIRED: 'Your session has ended. Sign in again to continue.',
  INVALID_TOKEN: 'This link is no longer valid. Sign in with an email code instead.',
  TOKEN_EXPIRED: 'This link has expired. Sign in with an email code instead.',
  INVITATION_UNAVAILABLE: "This invitation couldn't be opened. It may have expired or been withdrawn: ask for a new one.",
  ACCOUNT_DISABLED: 'This account is disabled. Ask your administrator to turn it on again.',
  ADDRESS_RESERVED: 'This address is reserved for an administrator. Sign up with an email code or a sign-in provider instead.',
  NOT_WHILE_IMPERSONATING: 'Not possible while signed in as another user. Return to your own account first.',
  ALREADY_MEMBER: 'You are already a member of this workspace. Open it from the workspace menu.',
  INVALID_OTP: 'That code is not right. Check the email and try again.',
  OTP_EXPIRED: 'That code has expired. Ask for a new one.',
  TOO_MANY_ATTEMPTS: 'Too many tries with this code. Ask for a new one.',
  INVALID_EMAIL_OR_PASSWORD: "That email and password don't match.",
  INVALID_EMAIL: 'Enter a valid email address.',
  INVALID_PASSWORD: "That email and password don't match.",
  PASSWORD_TOO_SHORT: 'Use at least 8 characters for the password.',
  PASSWORD_TOO_LONG: 'That password is too long.',
  USER_ALREADY_EXISTS: 'There is already an account with this email. Sign in instead.',
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: 'There is already an account with this email. Sign in instead.',
  EMAIL_NOT_VERIFIED: 'Confirm your email first: sign in with an email code once.',
  TOO_MANY_REQUESTS: 'Too many tries. Wait a minute, then try again.',
  [PASSKEY_CANCELLED]: 'Passkey sign-in was cancelled.',
  PASSKEY_NOT_FOUND: "That passkey isn't set up for Linedesk. Sign in another way, then add it in Account settings.",
  AUTHENTICATION_FAILED: 'That passkey did not work. Try again.',
  ERROR_CEREMONY_ABORTED: 'Adding the passkey was cancelled.',
  ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED: 'This passkey is already added.',
  SESSION_NOT_FRESH: 'Sign in again to do this.',
  PASSKEY_ENROLMENT_REQUIRED: 'That enrolment code is not right or has expired. Ask an instance admin for a new one.',
}

const CONNECTION_FAILED = "We couldn't reach Linedesk. Check your internet connection, then try again."
const SERVER_FAILED = 'Something went wrong on our side. Try again in a few minutes. If it keeps happening, contact your administrator.'
const UNEXPECTED = "That didn't work. Try again. If it keeps happening, contact your administrator."

/** What older servers send as a message only, without a code. */
const knownMessages: Record<string, string> = {
  'invalid origin': 'INVALID_ORIGIN',
  'missing or null origin': 'MISSING_OR_NULL_ORIGIN',
  'sign-up is closed on this server': 'SIGNUP_CLOSED',
}
const networkMessages = ['failed to fetch', 'network error', 'networkerror when attempting to fetch resource', 'load failed']

/**
 * A readable message for a failed sign-in: what happened, then what to do (ui/AuthError.tsx shows
 * the first sentence as the heading). Better Auth sends a code, a status and an English message;
 * the message itself never reaches the page, so no "Invalid origin" or server internals.
 */
export function authErrorMessage(error: unknown): string {
  const detail = error && typeof error === 'object' ? (error as { code?: unknown; message?: unknown; status?: unknown }) : {}
  const code = typeof detail.code === 'string' ? detail.code : ''
  const status = typeof detail.status === 'number' ? detail.status : undefined
  const message = typeof detail.message === 'string' ? detail.message.trim().replace(/\.$/, '').toLowerCase() : ''
  const known = Object.hasOwn(authErrors, code) ? code : knownMessages[message]
  if (known) return authErrors[known]!
  if (status === 429) return authErrors.TOO_MANY_REQUESTS!
  if (status === 0 || error instanceof TypeError || networkMessages.includes(message)) return CONNECTION_FAILED
  if (status !== undefined && status >= 500) return SERVER_FAILED
  if (status === 401) return authErrors.SESSION_EXPIRED!
  return UNEXPECTED
}

export const codeErrorMessage = authErrorMessage

/** An email field checked in the app's words: empty, or not shaped like an address. */
export function emailError(email: string): string | null {
  if (!email.trim()) return 'Enter an email address.'
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) ? null : authErrors.INVALID_EMAIL!
}

/** The sign-in and sign-up form, checked in the app's words before it is sent (no browser bubbles). */
export function authFormError(
  step: 'email' | 'password' | 'signUp',
  form: { name: string; email: string; password: string },
): string | null {
  if (step === 'signUp' && !form.name.trim()) return 'Enter your name.'
  const email = emailError(form.email)
  if (email || step === 'email') return email
  if (!form.password) return 'Enter your password.'
  if (step === 'signUp' && form.password.length < 8) return authErrors.PASSWORD_TOO_SHORT!
  return null
}
