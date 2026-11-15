// The sign-in code: what may be typed or pasted, and what the server's answers mean.
import type { MessageKey } from '@linedesk/i18n'
import { brandName } from './brand.ts'
import { i18n } from './i18n/index.tsx'

/** No open sign-up: what someone without an account and without an invitation is told (apps/api/src/signup-gate.ts). */
export const noAccountText = () => i18n().t('auth.error.signupClosed')

export const CODE_LENGTH = 6
/** Seconds before "Resend code" is offered. */
export const RESEND_AFTER_S = 30

/** Digits only, at most six: a pasted "123 456" or "Code: 123456" becomes "123456". */
export const normalizeCode = (value: string) => value.replace(/\D/g, '').slice(0, CODE_LENGTH)

/**
 * Better Auth's code for a passkey prompt the person closed. Built from parts: spelled out, it looks
 * like a server setting (AUTH_*) to the check that keeps those off owners' screens (owner-copy.test.ts).
 */
export const PASSKEY_CANCELLED = ['AUTH', 'CANCELLED'].join('_')
/** A passkey sign-in refused because the device did not check the person (apps/api/src/passkeys.ts). */
export const passkeyNotVerifiedText = () => i18n().t('auth.error.passkeyUserNotVerified')

/** Better Auth's error codes in the app's own words (auth.error.*). */
// i18n-dynamic: auth.error.*
const authErrors: Record<string, MessageKey> = {
  INVALID_ORIGIN: 'auth.error.invalidOrigin',
  MISSING_OR_NULL_ORIGIN: 'auth.error.missingOrNullOrigin',
  SESSION_EXPIRED: 'auth.error.sessionExpired',
  INVALID_TOKEN: 'auth.error.invalidToken',
  TOKEN_EXPIRED: 'auth.error.tokenExpired',
  ACCOUNT_DISABLED: 'auth.error.accountDisabled',
  NOT_WHILE_IMPERSONATING: 'auth.error.notWhileImpersonating',
  ALREADY_MEMBER: 'auth.error.alreadyMember',
  INVALID_OTP: 'auth.error.invalidOtp',
  OTP_EXPIRED: 'auth.error.otpExpired',
  TOO_MANY_ATTEMPTS: 'auth.error.tooManyAttempts',
  INVALID_EMAIL_OR_PASSWORD: 'auth.error.invalidEmailOrPassword',
  INVALID_EMAIL: 'auth.error.invalidEmail',
  INVALID_PASSWORD: 'auth.error.invalidEmailOrPassword',
  PASSWORD_TOO_SHORT: 'auth.error.passwordTooShort',
  PASSWORD_TOO_LONG: 'auth.error.passwordTooLong',
  USER_ALREADY_EXISTS: 'auth.error.userAlreadyExists',
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: 'auth.error.userAlreadyExists',
  EMAIL_NOT_VERIFIED: 'auth.error.emailNotVerified',
  TOO_MANY_REQUESTS: 'auth.error.tooManyRequests',
  [PASSKEY_CANCELLED]: 'auth.error.passkeyCancelled',
  PASSKEY_NOT_FOUND: 'auth.error.passkeyNotFound',
  AUTHENTICATION_FAILED: 'auth.error.authenticationFailed',
  PASSKEY_OTHER_ACCOUNT: 'auth.error.passkeyOtherAccount',
  ERROR_CEREMONY_ABORTED: 'auth.error.errorCeremonyAborted',
  ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY: 'auth.error.errorPassthroughSeeCauseProperty',
  ERROR_INVALID_RP_ID: 'auth.error.errorInvalidRpId',
  ERROR_INVALID_DOMAIN: 'auth.error.errorInvalidRpId',
  ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED: 'auth.error.errorAuthenticatorPreviouslyRegistered',
  SESSION_NOT_FRESH: 'auth.error.sessionNotFresh',
  EMAIL_UNUSABLE: 'auth.error.emailUnusable',
  PASSKEY_ENROLMENT_REQUIRED: 'auth.error.passkeyEnrolmentRequired',
  SIGNUP_CLOSED: 'auth.error.signupClosed',
  INVITATION_UNAVAILABLE: 'auth.error.invitationUnavailable',
  ADDRESS_RESERVED: 'auth.error.addressReserved',
  PASSKEY_USER_NOT_VERIFIED: 'auth.error.passkeyUserNotVerified',
}

/** The text of a known error code, in the active language. */
const authErrorText = (code: string) => i18n().t(authErrors[code]!, { brand: brandName() })

/** What older servers send as a message only, without a code. */
const knownMessages: Record<string, string> = {
  'invalid origin': 'INVALID_ORIGIN',
  'missing or null origin': 'MISSING_OR_NULL_ORIGIN',
  'sign-up is closed on this server': 'SIGNUP_CLOSED',
  'no account for this email. ask your workspace admin for an invitation': 'SIGNUP_CLOSED',
}
const networkMessages = [
  'failed to fetch',
  'network error',
  'networkerror when attempting to fetch resource',
  'load failed',
]

/**
 * A readable message for a failed sign-in: what happened, then what to do (ui/AuthError.tsx shows
 * the first sentence as the heading). Better Auth sends a code, a status and an English message;
 * the message itself never reaches the page, so no "Invalid origin" or server internals.
 */
export function authErrorMessage(error: unknown): string {
  const detail =
    error && typeof error === 'object' ? (error as { code?: unknown; message?: unknown; status?: unknown }) : {}
  const code = typeof detail.code === 'string' ? detail.code : ''
  const status = typeof detail.status === 'number' ? detail.status : undefined
  const message = typeof detail.message === 'string' ? detail.message.trim().replace(/\.$/, '').toLowerCase() : ''
  const known = Object.hasOwn(authErrors, code) ? code : knownMessages[message]
  const { t } = i18n()
  if (known) return authErrorText(known)
  if (status === 429) return authErrorText('TOO_MANY_REQUESTS')
  if (status === 0 || error instanceof TypeError || networkMessages.includes(message))
    return t('auth.error.connection', { brand: brandName() })
  if (status !== undefined && status >= 500) return t('auth.error.server')
  if (status === 401) return authErrorText('SESSION_EXPIRED')
  return t('auth.error.unexpected')
}

export const codeErrorMessage = authErrorMessage

/** An email field checked in the app's words: empty, or not shaped like an address. */
export function emailError(email: string): string | null {
  if (!email.trim()) return i18n().t('auth.form.emailMissing')
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) ? null : authErrorText('INVALID_EMAIL')
}

/** "Forgot password?" works where passwords are on and email codes reach people; without email an administrator helps. */
export function passwordResetOffer(methods: { password: boolean; emailCode: boolean }): 'reset' | 'ask-admin' | null {
  if (!methods.password) return null
  return methods.emailCode ? 'reset' : 'ask-admin'
}

/**
 * The reset step's answers. The server gives every refused code one answer (wrong, expired, out of
 * tries, or no account), so the message names them all.
 */
export function resetErrorMessage(error: unknown): string {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined
  if (code === 'INVALID_OTP') return i18n().t('auth.reset.wrongCode', { tries: 3 })
  return authErrorMessage(error)
}

/** A new password, by the sign-up rules (Better Auth's 8 characters at least). */
export function newPasswordError(password: string): string | null {
  if (!password) return i18n().t('auth.form.newPasswordMissing')
  return password.length < 8 ? authErrorText('PASSWORD_TOO_SHORT') : null
}

/** The sign-in and sign-up form, checked in the app's words before it is sent (no browser bubbles). */
export function authFormError(
  step: 'email' | 'password' | 'signUp',
  form: { name: string; email: string; password: string },
): string | null {
  if (step === 'signUp' && !form.name.trim()) return i18n().t('shell.askName.empty')
  const email = emailError(form.email)
  if (email || step === 'email') return email
  if (!form.password) return i18n().t('auth.form.passwordMissing')
  if (step === 'signUp' && form.password.length < 8) return authErrorText('PASSWORD_TOO_SHORT')
  return null
}
