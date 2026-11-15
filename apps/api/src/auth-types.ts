// What GET /v1/auth-methods returns. Types only, so the web app can import them.
export type SsoMethod = { id: string; label: string }
/** `emailCode`: sign in with a code sent by email (needs email delivery). */
/** `passkey`: sign in with a passkey added in Account settings (AUTH_PASSKEY_ENABLED, on by default). */
export type AuthMethods = {
  password: boolean
  emailCode: boolean
  passkey: boolean
  sso: SsoMethod[]
  links: LegalLinks
  /**
   * The address provider sign-ins (Google, Microsoft, GitHub, SSO) must start from: the provider sends
   * the browser back there, and the sign-in's state cookie only exists on the address it began on.
   * Absent from an older API.
   */
  signInOrigin?: string | null
  /** Nobody has an account yet: the sign-in page asks for the setup code from the server log (setup.ts). */
  setupNeeded?: boolean
  /** Sentry for the web app's own errors (error-reporting.ts); null or absent: off. */
  errorReporting?: { dsn: string; environment: string } | null
}
/** Terms, privacy policy and support contact of this install (TERMS_URL, PRIVACY_URL, SUPPORT_EMAIL); null: not set, not shown. */
export type LegalLinks = { terms: string | null; privacy: string | null; supportEmail: string | null }
