// What GET /v1/auth-methods returns. Types only, so the web app can import them.
export type SsoMethod = { id: string; label: string }
/** `signUp`: false when AUTH_SIGNUP_ENABLED=false; existing users still sign in. */
export type AuthMethods = { password: boolean; magicLink: boolean; signUp?: boolean; sso: SsoMethod[] }
