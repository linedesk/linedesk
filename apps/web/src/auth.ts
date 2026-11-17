import { type EnrolmentCode, rememberEnrolmentCode } from './enrolment-code.ts'
import { browserPlace } from './countryHint.ts'
import { passkeyClient } from '@better-auth/passkey/client'
import { emailOTPClient, inferAdditionalFields, organizationClient } from 'better-auth/client/plugins'
import type { AuthMethods, LegalLinks, SsoMethod } from '@linedesk/api/auth-types'
import { createAuthClient } from 'better-auth/react'
import type { FirstUse, OnboardingStep, StarPrompt } from '@linedesk/actions'

import type { Impersonation } from './impersonation.ts'
import { authErrorMessage, noAccountText } from './sign-in-code.ts'
import { readLastUsedMethod } from './sign-in-methods.ts'
import { announceSwitch } from './tabWorkspace.ts'
import { brandName } from './brand.ts'
import { i18n } from './i18n/index.tsx'

export type { AuthMethods, LegalLinks, SsoMethod }

export const auth = createAuthClient({
  // Same origin as the page (the API is proxied). Not read at import time, so tests can load this module without a browser.
  baseURL: typeof window === 'undefined' ? undefined : window.location.origin,
  plugins: [
    organizationClient(),
    emailOTPClient(),
    passkeyClient(),
    // The UI language fields of the user (apps/api/src/user-locale.ts), set through updateUser.
    inferAdditionalFields({
      user: { locale: { type: 'string', required: false }, localeAuto: { type: 'string', required: false } },
    }),
  ],
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
  /** The member's own profile picture; null or absent (an older version remembered it): the initials show. */
  avatarUrl?: string | null
  /** An owner or admin changed the member's name or picture last; null when they did (absent from an older server). */
  profileChangedBy?: { name: string; at: string } | null
  /** `iconUrl`: the workspace icon (Workspace settings › General); null or absent: the initial shows. */
  /**
   * `billingState`: on a bill, `pending_payment` until Checkout, then `active` or `suspended`; null or absent off
   * billing. `trialDays` and `plan`: while `pending_payment`, the install's free trial length and the plan's price at
   * the chosen interval. `extraNumberCents`: on a bill, what each extra number costs a month (null: free or no bill).
   */
  workspace: {
    id: string
    name: string
    disabled?: boolean
    iconUrl?: string | null
    billingState?: 'pending_payment' | 'active' | 'suspended' | null
    trialDays?: number | null
    plan?: { interval: 'month' | 'year'; cents: number } | null
    extraNumberCents?: number | null
  } | null
  /** Every workspace this member belongs to, by name (absent in what an older version remembered). */
  workspaces?: { id: string; name: string; disabled?: boolean; iconUrl?: string | null }[]
  onboarding: OnboardingState | null
  /**
   * After onboarding, for owners and admins: what "Find your business" offers when they go through the setup steps
   * again from the settings (onboarding/StepByStep.tsx). Null otherwise; absent from an older server.
   */
  businessSetup?: Pick<OnboardingState, 'businessLookup' | 'websiteImport'> | null
  /** null for members who cannot change settings. */
  phoneSetup: PhoneSetupStatus | null
  /** Set while an instance admin is signed in as this user. */
  impersonation: Impersonation | null
  /** The UI language the member chose; null: Automatic (follows the browser). Absent from an older server. */
  locale?: string | null
  /** What Automatic last resolved to in the member's browser (for emails). */
  localeAuto?: string | null
  /** When the session ends unless it is used again; null for an API key (absent in what an older version remembered). */
  sessionExpiresAt?: string | null
  /** An instance admin whose session has not passed the passkey check for Server admin: what is still missing. */
  adminSecondFactor?: AdminSecondFactor | null
  /** An instance admin without a passkey: their first needs the enrolment code another admin (or the CLI) gave them. */
  passkeyEnrolment?: boolean
  /** Whether the member has a passkey; null when this install has passkeys off (absent in what an older version remembered). */
  hasPasskey?: boolean | null
  /** An instance admin's authenticator app, the alternative to the passkey for Server admin; null for everyone else. */
  hasAuthenticator?: boolean | null
  /** This session's check was a passkey sign-in (not the app's code): changing the authenticator app needs it. */
  passkeySignedIn?: boolean
  /** The address is not confirmed yet: the app asks for a code, and sensitive actions wait for it. */
  emailUnconfirmed?: boolean
  /** How this install introduces a new workspace after onboarding: tour, sample calls, both or off. */
  firstUse?: FirstUse
  /** The GitHub star prompt while it is due for this member (absent in what an older version remembered). */
  starPrompt?: StarPrompt | null
  /** An instance admin who chose to set up this install by hand: no agent setup page first (absent for others). */
  setupByHand?: boolean
}

/**
 * What an instance admin still has to do before Server admin (apps/api/src/admin-second-factor.ts): `confirm` with
 * their passkey in this session (it counts 12 hours), `enrol` their first passkey (with an enrolment code), or confirm
 * their `email` address first (adding a passkey needs it).
 */
export type AdminSecondFactor = 'email' | 'enrol' | 'confirm'

/**
 * An instance admin: the one check for every place that offers Server admin or its links (Server admin › Providers). One who still
 * has to pass the passkey check (`adminSecondFactor`, sent only to instance admins) counts too: Admin opens on that
 * prompt, so the link still leads to the fix.
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
    if (attempt >= attempts) throw new Error(i18n().t('auth.error.methodsUnreachable'))
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
    throw new Error(body?.error ?? body?.message ?? i18n().t('auth.setup.failed'))
  }
  const body = (await res.json().catch(() => ({}))) as { signedIn?: boolean; enrolment?: EnrolmentCode | null }
  // The first passkey's enrolment code: Account › Sign-in & security fills it in (enrolment-code.ts).
  rememberEnrolmentCode(body.enrolment)
  return body
}

/**
 * `country`: where the business is, only when picked (saved as set); null: left as prefilled, so it stays Automatic and
 * a number connected later still decides it. The time zone and browser language go along: the API keeps the country
 * hint the field was prefilled with (country-hint.ts), only its two-letter code.
 */
export async function createWorkspace(name: string, country: string | null) {
  const res = await fetch('/v1/workspaces', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    // The workspace's time zone for working hours; the API falls back to US Eastern.
    body: JSON.stringify({ name, ...(country ? { country } : {}), ...browserPlace() }),
  })
  const body = (await res.json().catch(() => ({}))) as { error?: string; workspace?: { id: string } }
  if (!res.ok) throw new Error(body.error ?? i18n().t('auth.createWorkspace.failed'))
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

/** "Forgot password?": a code to this address, if it has an account (the answer is the same either way). */
export function requestPasswordResetCode(email: string) {
  return auth.emailOtp.requestPasswordReset({ email })
}

/** Sets a new password with the emailed code. Every session of the account ends; sign in with it afterwards. */
export function resetPasswordWithCode(email: string, otp: string, password: string) {
  return auth.emailOtp.resetPassword({ email, otp, password })
}

/** Signs in with the emailed code (there is no sign-up; an invited address gets its account on this first sign-in). */
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
const unprovenEmail = (provider: string | null) => {
  const name = provider && providerNames[provider]
  return name ? i18n().t('auth.redirect.unproven', { provider: name }) : i18n().t('auth.redirect.unprovenUnknown')
}

const redirectErrors: Record<string, (provider: string | null) => string> = {
  // Better Auth's own: the state cookie or record of this sign-in is gone, expired or from another browser.
  state_mismatch: () => i18n().t('auth.redirect.stateMismatch'),
  state_not_found: () => i18n().t('auth.redirect.stateNotFound'),
  invalid_callback_request: () => i18n().t('auth.redirect.invalidCallback'),
  access_denied: () => i18n().t('auth.redirect.accessDenied'),
  account_not_linked: unprovenEmail,
  email_not_found: unprovenEmail,
  SIGNUP_CLOSED: noAccountText,
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
  i18n().t('auth.redirect.elsewhere', { host, brand: brandName() })
