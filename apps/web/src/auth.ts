import { passkeyClient } from '@better-auth/passkey/client'
import { emailOTPClient, organizationClient } from 'better-auth/client/plugins'
import type { AuthMethods, LegalLinks, SsoMethod } from '@linedesk/api/auth-types'
import { createAuthClient } from 'better-auth/react'

import type { Impersonation } from './impersonation.ts'
import { readLastUsedMethod } from './sign-in-methods.ts'

export type { AuthMethods, LegalLinks, SsoMethod }

export const auth = createAuthClient({
  // Same origin as the page (the API is proxied). Not read at import time, so tests can load this module without a browser.
  baseURL: typeof window === 'undefined' ? undefined : window.location.origin,
  plugins: [organizationClient(), emailOTPClient(), passkeyClient()],
})

/** Whether this server can set up phone numbers and with which carrier. `detail` (what the server lacks) only reaches instance admins. */
export type PhoneSetupStatus = { provider: string | null; available: boolean; detail: string | null }
/** Present while the workspace is in onboarding and this member may finish it. */
export type OnboardingState = { step: 'business' | 'phone' | 'test_call'; phone: PhoneSetupStatus }

export type Me = {
  actorId: string; role: string; permissions: string[]; workspace: { id: string; name: string; disabled?: boolean } | null
  onboarding: OnboardingState | null
  /** null for members who cannot change settings. */
  phoneSetup: PhoneSetupStatus | null
  /** Set while an instance admin is signed in as this user. */
  impersonation: Impersonation | null
  /** An instance admin whose session lacks the passkey the admin area needs: add one, or sign in with it. */
  adminSecondFactor?: AdminSecondFactor | null
}

export type AdminSecondFactor = 'setup' | 'confirm'

/** Who am I and which workspace am I in? null when signed out or without a workspace. */
export async function fetchMe(): Promise<Me | null> {
  const res = await fetch('/v1/me', { credentials: 'include' })
  return res.ok ? ((await res.json()) as Me) : null
}

export async function isSignedIn(): Promise<boolean> {
  return Boolean((await auth.getSession()).data)
}

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Keeps trying while the API is unreachable (for example during a restart), so the screen recovers by itself.
 * With `attempts`, gives up after that many tries and throws, so a page can show its error instead.
 */
export async function fetchAuthMethods({ retryMs = [500, 1000, 2000, 4000, 8000], attempts = Number.POSITIVE_INFINITY } = {}): Promise<AuthMethods> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch('/v1/auth-methods').catch(() => null)
    if (res?.ok) return (await res.json()) as AuthMethods
    if (attempt >= attempts) throw new Error('Could not reach the server. Try again in a moment.')
    await wait(retryMs[Math.min(attempt - 1, retryMs.length - 1)] ?? 8000)
  }
}

export async function createWorkspace(name: string) {
  const res = await fetch('/v1/workspaces', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    // The workspace's time zone for working hours; the API falls back to US Eastern.
    body: JSON.stringify({ name, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
  })
  if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error ?? 'Could not create the workspace')
}

/** Where the API sends the browser back to: errors arrive as `?error=CODE` on the sign-in screen. */
// A successful sign-in returns to the page it started from (`#account` after "Sign in again").
const back = () => ({ callbackURL: window.location.origin + window.location.pathname + window.location.hash, errorCallbackURL: window.location.origin })

/** Emails a sign-in code. The answer is the same whether or not the address has an account. */
export function requestSignInCode(email: string) {
  return auth.emailOtp.sendVerificationOtp({ email, type: 'sign-in' })
}

/** Signs in (or, where sign-up is open, signs up) with the emailed code. */
export function signInWithCode(email: string, otp: string) {
  return auth.signIn.emailOtp({ email, otp })
}

/** Whether this browser can use passkeys: WebAuthn, on https or localhost. */
export function passkeySupported(): boolean {
  return typeof window !== 'undefined' && window.isSecureContext && typeof window.PublicKeyCredential === 'function'
}

/** Asks the browser for one of this site's passkeys and signs in with it. Only existing accounts have one. */
export function signInWithPasskey() {
  return auth.signIn.passkey()
}

/** Leaves the page for the provider; the session exists when the browser comes back. */
export function startSso(method: SsoMethod) {
  return auth.signIn.social({ provider: method.id, ...back() })
}

const providerNames: Record<string, string> = { google: 'Google', microsoft: 'Microsoft', github: 'GitHub' }

/** The provider didn't prove the address, so it signs nobody in (the API's account-linking rule). */
const unprovenEmail = (provider: string | null) =>
  `${(provider && providerNames[provider]) || 'The sign-in provider'} didn't confirm this email address, so it can't sign you in. Sign in with an email code instead.`

const redirectErrors: Record<string, (provider: string | null) => string> = {
  access_denied: () => 'Sign-in was cancelled.',
  account_not_linked: unprovenEmail,
  email_not_found: unprovenEmail,
  SIGNUP_CLOSED: () => 'There is no account for this address. Ask your administrator for one.',
}

/**
 * Reads and clears the `?error=` a failed SSO redirect leaves in the address bar. The provider is the
 * one this device started with (the sign-in page remembers it before leaving).
 */
export function takeRedirectError(): string | null {
  const url = new URL(window.location.href)
  const code = url.searchParams.get('error')
  if (!code) return null
  url.searchParams.delete('error')
  url.searchParams.delete('error_description')
  window.history.replaceState(null, '', url)
  const message = redirectErrors[code]
  return message ? message(readLastUsedMethod()) : `Sign-in did not work (${code.replaceAll('_', ' ').toLowerCase()}). Try again.`
}

/** Ends this session and shows the sign-in screen; signing in comes back to the same page. */
export async function signInAgain() {
  await auth.signOut()
  window.location.reload()
}
