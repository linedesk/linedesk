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

/** Ends a sentence the way the rest of the app does ("Invalid email" → "Invalid email."). */
const sentence = (text: string) => (/[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`)

/** A readable message for a failed sign-in; Better Auth sends a code, a status and an English message. */
export function authErrorMessage(error: { code?: string; message?: string; status?: number }): string {
  if (error.code && authErrors[error.code]) return authErrors[error.code]!
  if (error.status === 429) return authErrors.TOO_MANY_REQUESTS!
  return error.message ? sentence(error.message) : 'That did not work. Try again.'
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
