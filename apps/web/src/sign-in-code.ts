// The sign-in code: what may be typed or pasted, and what the server's answers mean.
export const CODE_LENGTH = 6
/** Seconds before "Resend code" is offered. */
export const RESEND_AFTER_S = 30

/** Digits only, at most six: a pasted "123 456" or "Code: 123456" becomes "123456". */
export const normalizeCode = (value: string) => value.replace(/\D/g, '').slice(0, CODE_LENGTH)

const codeErrors: Record<string, string> = {
  INVALID_OTP: 'That code is not right. Check the email and try again.',
  OTP_EXPIRED: 'That code has expired. Ask for a new one.',
  TOO_MANY_ATTEMPTS: 'Too many tries with this code. Ask for a new one.',
}

/** A readable message for a failed code sign-in; Better Auth sends a code and an English message. */
export function codeErrorMessage(error: { code?: string; message?: string }): string {
  return (error.code && codeErrors[error.code]) || error.message || 'That did not work. Try again.'
}
