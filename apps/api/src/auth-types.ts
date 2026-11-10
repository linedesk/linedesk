// What GET /v1/auth-methods returns. Types only, so the web app can import them.
export type SsoMethod = { id: string; label: string }
export type AuthMethods = { password: boolean; magicLink: boolean; sso: SsoMethod[] }
