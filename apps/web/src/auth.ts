import { emailOTPClient, organizationClient } from 'better-auth/client/plugins'
import type { AuthMethods, SsoMethod } from '@callfront/api/auth-types'
import { createAuthClient } from 'better-auth/react'

export type { AuthMethods, SsoMethod }

export const auth = createAuthClient({
  // Same origin as the page (the API is proxied). Not read at import time, so tests can load this module without a browser.
  baseURL: typeof window === 'undefined' ? undefined : window.location.origin,
  plugins: [organizationClient(), emailOTPClient()],
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
}

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

/** Leaves the page for the provider; the session exists when the browser comes back. */
export function startSso(method: SsoMethod) {
  return auth.signIn.social({ provider: method.id, ...back() })
}

const redirectErrors: Record<string, string> = {
  access_denied: 'Sign-in was cancelled.',
  account_not_linked: 'This email already has an account. Sign in with an email code once, then this works too.',
}

/** Reads and clears the `?error=` a failed SSO redirect leaves in the address bar. */
export function takeRedirectError(): string | null {
  const url = new URL(window.location.href)
  const code = url.searchParams.get('error')
  if (!code) return null
  url.searchParams.delete('error')
  url.searchParams.delete('error_description')
  window.history.replaceState(null, '', url)
  return redirectErrors[code] ?? `Sign-in did not work (${code.replaceAll('_', ' ').toLowerCase()}). Try again.`
}

/** Ends this session and shows the sign-in screen; signing in comes back to the same page. */
export async function signInAgain() {
  await auth.signOut()
  window.location.reload()
}
