import { passkeyClient } from '@better-auth/passkey/client'
import { emailOTPClient, organizationClient } from 'better-auth/client/plugins'
import type { AuthMethods, LegalLinks, SsoMethod } from '@linedesk/api/auth-types'
import { createAuthClient } from 'better-auth/react'
import type { FirstUse, OnboardingStep, StarPrompt } from '@linedesk/actions'

import type { Impersonation } from './impersonation.ts'
import { authErrorMessage } from './sign-in-code.ts'
import { readLastUsedMethod } from './sign-in-methods.ts'
import { announceSwitch } from './tabWorkspace.ts'
import { brandName } from './brand.ts'

export type { AuthMethods, LegalLinks, SsoMethod }

export const auth = createAuthClient({
  // Same origin as the page (the API is proxied). Not read at import time, so tests can load this module without a browser.
  baseURL: typeof window === 'undefined' ? undefined : window.location.origin,
  plugins: [organizationClient(), emailOTPClient(), passkeyClient()],
})

/** Whether this server can set up phone numbers and with which carrier. `detail` (what the server lacks) only reaches instance admins. */
/** `canAttach`: the member may connect a number already in the carrier account (else only a new one). */
export type PhoneSetupStatus = {
  provider: string | null
  available: boolean
  detail: string | null
  canAttach: boolean
}
/** Present while the workspace is in onboarding and this member may finish it. */
/**
 * `businessLookup`: the install can look businesses up by name and city. `websiteImport`: whether the business step
 * may offer to read the website: `no_model` without a language model, `paused` when today's lookups are used up or
 * turned off. Both absent in what an older version remembered.
 */
export type WebsiteImport = 'on' | 'no_model' | 'paused'
export type OnboardingState = {
  step: Exclude<OnboardingStep, 'done'>
  phone: PhoneSetupStatus
  businessLookup?: boolean
  websiteImport?: WebsiteImport
}

export type Me = {
  actorId: string
  role: string
  permissions: string[]
  workspace: { id: string; name: string; disabled?: boolean } | null
  /** Every workspace this member belongs to, by name (absent in what an older version remembered). */
  workspaces?: { id: string; name: string; disabled?: boolean }[]
  onboarding: OnboardingState | null
  /** null for members who cannot change settings. */
  phoneSetup: PhoneSetupStatus | null
  /** Set while an instance admin is signed in as this user. */
  impersonation: Impersonation | null
  /** An instance admin who must confirm their email address or sign in again before the admin area. */
  adminSecondFactor?: AdminSecondFactor | null
  /** An instance admin without a passkey: their first needs the enrolment code another admin (or the CLI) gave them. */
  passkeyEnrolment?: boolean
  /** The address is not confirmed yet: the app asks for a code, and sensitive actions wait for it. */
  emailUnconfirmed?: boolean
  /** How this install introduces a new workspace after onboarding: tour, sample calls, both or off. */
  firstUse?: FirstUse
  /** The GitHub star prompt while it is due for this member (absent in what an older version remembered). */
  starPrompt?: StarPrompt | null
  /** An instance admin who chose to set up this install by hand: no agent setup page first (absent for others). */
  setupByHand?: boolean
}

/** `email`: the address is not confirmed yet; `confirm`: the last sign-in is more than 12 hours ago. */
export type AdminSecondFactor = 'email' | 'confirm'

/**
 * An instance admin: the one check for every place that offers Admin or its links (Admin › Providers). One who still
 * has to confirm their email or sign in again (`adminSecondFactor`, sent only to instance admins) counts too: Admin
 * opens on that prompt, so the link still leads to the fix.
 */
export const isInstanceAdmin = (me: Pick<Me, 'permissions' | 'adminSecondFactor'>): boolean =>
  me.permissions.includes('instance:admin') || Boolean(me.adminSecondFactor)

/** Who am I and which workspace am I in? null when signed out or without a workspace. */
export async function fetchMe(): Promise<Me | null> {
  const res = await fetch('/v1/me', { credentials: 'include' })
  return res.ok ? ((await res.json()) as Me) : null
}

/** The signed-in account's id, or null when signed out. */
export async function signedInAccount(): Promise<string | null> {
  return (await auth.getSession()).data?.user.id ?? null
}

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Keeps trying while the API is unreachable (for example during a restart), so the screen recovers by itself.
 * With `attempts`, gives up after that many tries and throws, so a page can show its error instead.
 */
export async function fetchAuthMethods({
  retryMs = [500, 1000, 2000, 4000, 8000],
  attempts = Number.POSITIVE_INFINITY,
} = {}): Promise<AuthMethods> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch('/v1/auth-methods').catch(() => null)
    if (res?.ok) return (await res.json()) as AuthMethods
    if (attempt >= attempts) throw new Error('Could not reach the server. Try again in a moment.')
    await wait(retryMs[Math.min(attempt - 1, retryMs.length - 1)] ?? 8000)
  }
}

/** The first admin of a fresh install, with the setup code from the server log (apps/api/src/setup.ts). Signs them in. */
export async function completeSetup(input: { code: string; name: string; email: string; password: string }) {
  const res = await fetch('/v1/setup', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string; message?: string } | null
    throw new Error(body?.error ?? body?.message ?? 'Setup did not work. Try again.')
  }
  return (await res.json().catch(() => ({}))) as { signedIn?: boolean }
}

export async function createWorkspace(name: string) {
  const res = await fetch('/v1/workspaces', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    // The workspace's time zone for working hours; the API falls back to US Eastern.
    body: JSON.stringify({ name, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
  })
  const body = (await res.json().catch(() => ({}))) as { error?: string; workspace?: { id: string } }
  if (!res.ok) throw new Error(body.error ?? 'Could not create the workspace')
  // The new workspace is now the session's: other open tabs say which one they are on.
  if (body.workspace) announceSwitch(body.workspace.id)
}

/** Where the API sends the browser back to: errors arrive as `?error=CODE` on the sign-in screen. */
// A successful sign-in returns to the page it started from (`#account` after "Sign in again").
const back = () => ({
  callbackURL: window.location.origin + window.location.pathname + window.location.hash,
  errorCallbackURL: window.location.origin + window.location.pathname + window.location.hash,
})

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
  // Better Auth's own: the state cookie or record of this sign-in is gone, expired or from another browser.
  state_mismatch: () =>
    'This sign-in took too long or was started in another browser. Start again below and finish in the same tab. If it keeps happening, allow cookies for this site.',
  state_not_found: () => 'This sign-in could not be finished. Start again below and finish in the same tab.',
  invalid_callback_request: () => 'This sign-in could not be finished. Start again below.',
  access_denied: () => 'Sign-in was cancelled. Choose a way to sign in below.',
  account_not_linked: unprovenEmail,
  email_not_found: unprovenEmail,
  SIGNUP_CLOSED: () => 'There is no account for this address. Ask your administrator for one.',
}

/** The words for a `?error=` code a provider sign-in came back with; unknown codes never show as such. */
export function redirectErrorMessage(code: string, provider: string | null): string {
  const message = Object.hasOwn(redirectErrors, code) ? redirectErrors[code] : undefined
  return message ? message(provider) : authErrorMessage({ code: code.toUpperCase() })
}

/**
 * Reads and clears the `?error=` a failed SSO redirect leaves in the address bar. The provider is the
 * one this device started with (the sign-in page remembers it before leaving).
 */
export function takeRedirectError(): { code: string; message: string } | null {
  const url = new URL(window.location.href)
  const code = url.searchParams.get('error')
  if (!code) return null
  url.searchParams.delete('error')
  url.searchParams.delete('error_description')
  window.history.replaceState(null, '', url)
  return { code, message: redirectErrorMessage(code, readLastUsedMethod()) }
}

/** The codes of a provider sign-in that lost its state: what happens when it began on another address. */
const LOST_STATE = new Set(['state_mismatch', 'state_not_found', 'invalid_callback_request'])
export const lostSignInState = (code: string | undefined) => Boolean(code && LOST_STATE.has(code))

/**
 * The address provider sign-ins must start from, when this page is open at another one (a local
 * name while PUBLIC_URL is a tunnel): the provider would send the browser back to the other
 * address, where this sign-in's state cookie does not exist. null when this is the right address.
 */
export function providerSignInElsewhere(methods: Pick<AuthMethods, 'signInOrigin'>, here = window.location.origin) {
  const origin = methods.signInOrigin
  if (!origin || origin === here) return null
  const { host } = new URL(origin)
  // The same page there (Admin stays Admin); outside a browser just the address.
  const page = typeof window === 'undefined' ? '/' : window.location.pathname + window.location.hash
  return { origin, host, href: origin + page }
}

/** What the sign-in page says when a provider sign-in has to start at `host`. */
export const providerElsewhereMessage = (host: string) =>
  `Sign-in with Google, Microsoft or GitHub has to start from ${host}. Open ${brandName()} there and sign in again.`
