import { expect, test } from 'vitest'
import { authErrorMessage, authFormError, codeErrorMessage, noAccountText, newPasswordError, normalizeCode, passwordResetOffer, resetErrorMessage } from './sign-in-code.ts'
import { splitAuthError } from './ui/AuthError.tsx'

test('the code field keeps digits only, at most six, so a pasted code works', () => {
  expect(normalizeCode('123456')).toBe('123456')
  expect(normalizeCode('123 456')).toBe('123456')
  expect(normalizeCode('Code: 123-456 ')).toBe('123456')
  expect(normalizeCode('1234567')).toBe('123456')
  expect(normalizeCode('abc')).toBe('')
})

test('server errors become short messages', () => {
  expect(codeErrorMessage({ code: 'INVALID_OTP', message: 'Invalid OTP' })).toMatch(/not right/)
  expect(codeErrorMessage({ code: 'OTP_EXPIRED' })).toMatch(/expired/)
  expect(codeErrorMessage({ code: 'TOO_MANY_ATTEMPTS' })).toMatch(/Too many tries/)
  expect(codeErrorMessage({ message: 'Sign-up is closed on this server.' })).toBe(noAccountText())
  expect(codeErrorMessage({ message: noAccountText() })).toBe('No account for this email. Ask your workspace admin for an invitation.')
  expect(codeErrorMessage({})).toMatch(/^That didn't work\. Try again\./)
})

test('password and sign-up errors use the app wording, never the library wording', () => {
  expect(authErrorMessage({ code: 'INVALID_EMAIL_OR_PASSWORD', message: 'Invalid email or password' })).toBe(
    "That email and password don't match.",
  )
  expect(authErrorMessage({ code: 'USER_ALREADY_EXISTS' })).toMatch(/Sign in instead/)
  expect(authErrorMessage({ status: 429, message: 'Too many requests' })).toMatch(/Wait a minute/)
  expect(authErrorMessage({ message: 'Something odd' })).not.toMatch(/odd/)
})

test('the sign-in form is checked in the app words before it is sent', () => {
  const form = { email: 'mike@example.com', password: 'long-enough' }
  expect(authFormError('email', { ...form, email: '' })).toBe('Enter an email address.')
  expect(authFormError('email', { ...form, email: 'mike@' })).toBe('Enter a valid email address.')
  expect(authFormError('email', { ...form, password: '' })).toBeNull()
  expect(authFormError('password', { ...form, password: '' })).toBe('Enter your password.')
  expect(authFormError('password', { ...form, password: 'short' })).toBeNull()
})


test('a page opened at an address the server does not trust says so, and where to go instead', () => {
  const message = authErrorMessage({ code: 'INVALID_ORIGIN', message: 'Invalid origin', status: 403 })
  expect(message).toMatch(/^This address isn't set up for sign-in\./)
  expect(message).toMatch(/link in your invitation|ask your administrator/)
  // Older servers send the library's message only.
  expect(authErrorMessage({ message: 'Invalid origin.', status: 403 })).toBe(message)
  expect(authErrorMessage({ message: 'Missing or null Origin', status: 403 })).toMatch(/Reload the page/)
})

test('connection failures and server errors get a plain message and what to do, never the server text', () => {
  expect(authErrorMessage(new TypeError('Failed to fetch'))).toMatch(/Check your connection/)
  expect(authErrorMessage({ status: 0, message: 'Load failed' })).toMatch(/Check your connection/)
  const server = authErrorMessage({ status: 500, message: 'SQL connection refused at internal-db:5432' })
  expect(server).toMatch(/^Something went wrong on our side\. Try again in a few minutes/)
  expect(server).not.toMatch(/SQL|internal-db/)
  expect(authErrorMessage({ status: 403, code: 'NEW_INTERNAL_ERROR', message: '<html>debug</html>' })).not.toMatch(/debug|html/)
  expect(authErrorMessage({ status: 401 })).toMatch(/Sign in again/)
  expect(authErrorMessage(null)).toMatch(/Try again/)
  expect(authErrorMessage('Invalid origin')).toMatch(/Try again/) // a bare string is never shown either
})

test("the server's own refusals keep their meaning", () => {
  expect(authErrorMessage({ code: 'ACCOUNT_DISABLED', message: 'This account is disabled.' })).toMatch(/disabled/)
  expect(authErrorMessage({ code: 'ADDRESS_RESERVED' })).toMatch(/reserved for an administrator/)
  expect(authErrorMessage({ code: 'NOT_WHILE_IMPERSONATING' })).toMatch(/own account/)
  expect(authErrorMessage({ code: 'ALREADY_MEMBER' })).toMatch(/already a member/)
  expect(authErrorMessage({ code: 'SIGNUP_CLOSED' })).toMatch(/invitation/)
  expect(authErrorMessage(Object.assign(new Error('invitation unavailable'), { code: 'INVITATION_UNAVAILABLE', status: 404 }))).toMatch(
    /^This invitation couldn't be opened\. It may have expired/,
  )
})

test('every message reads "what happened. what to do."; the panel shows the first sentence as its heading', () => {
  expect(splitAuthError('That code is not right. Check the email and try again.')).toEqual({
    title: 'That code is not right.',
    next: 'Check the email and try again.',
  })
  expect(splitAuthError('Enter a valid email address.')).toEqual({ title: 'Enter a valid email address.', next: null })
  for (const error of [{ code: 'INVALID_ORIGIN' }, { status: 500 }, new TypeError('x'), {}])
    expect(splitAuthError(authErrorMessage(error)).next, JSON.stringify(error)).not.toBeNull()
})

test('"Forgot password?" is offered only with passwords and email codes; without email an administrator helps', () => {
  expect(passwordResetOffer({ password: true, emailCode: true })).toBe('reset')
  expect(passwordResetOffer({ password: true, emailCode: false })).toBe('ask-admin')
  expect(passwordResetOffer({ password: false, emailCode: true })).toBeNull()
  expect(passwordResetOffer({ password: false, emailCode: false })).toBeNull()
})

test('the reset step names every reason a code is refused, and keeps the other messages', () => {
  expect(resetErrorMessage({ code: 'INVALID_OTP', message: 'Invalid OTP' })).toBe(
    'Wrong or expired code. Check the email, or ask for a new code after 3 tries.',
  )
  expect(resetErrorMessage({ code: 'PASSWORD_TOO_SHORT' })).toBe('Use at least 8 characters for the password.')
  expect(resetErrorMessage({ status: 429 })).toMatch(/Too many tries/)
})

test('a new password follows the sign-up rules', () => {
  expect(newPasswordError('')).toBe('Enter a new password.')
  expect(newPasswordError('short')).toBe('Use at least 8 characters for the password.')
  expect(newPasswordError('long-enough')).toBeNull()
})
