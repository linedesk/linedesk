// An instance admin's authenticator app (apps/api/src/authenticator.ts): the fallback to the passkey for Server
// admin. Start and remove are registry actions; confirm and check go through their own route, which also remembers
// this browser for the admins' new-device alert (apps/api/src/authenticator-routes.ts).
import type { AuthenticatorStartData } from '@linedesk/actions'
import { renderSVG } from 'uqr'
import { workspaceHeaders } from './tabWorkspace.ts'

/** The server failed without its own message; the caller words it with `authenticator.requestFailed`. */
export class AuthenticatorRequestError extends Error {
  status: number
  constructor(status: number) {
    super(`HTTP ${status}`) // i18n-ignore: replaced by authenticatorErrorText before it is shown
    this.status = status
  }
}

async function post<T>(path: string, input: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    credentials: 'include',
    headers: { ...workspaceHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
  const json = (await res.json().catch(() => null)) as { ok?: boolean; error?: string; data?: T } | null
  if (!res.ok || !json?.ok) throw json?.error ? new Error(json.error) : new AuthenticatorRequestError(res.status)
  return json.data as T
}

/** A new secret for the app (an admin with a passkey, in a session that passed the passkey check). */
export const startAuthenticator = () => post<AuthenticatorStartData>('/v1/actions/account.authenticatorStart', {})

/** The first code from the app: the app is added, and this session passed the Server admin check. */
export const confirmAuthenticator = (code: string) => post('/v1/account/authenticator/confirm', { code })

/** A code from the app: this session passed the Server admin check, for 12 hours. */
export const checkAuthenticator = (code: string) => post('/v1/account/authenticator/check', { code })

export const removeAuthenticator = () => post('/v1/actions/account.authenticatorRemove', {})

/** The QR code an app scans, as an SVG data address (drawn here: the secret never leaves the browser for it). */
export const qrCodeSrc = (otpauthUrl: string) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(renderSVG(otpauthUrl, { border: 2 }))}`

/** The secret in groups of four, as apps show and people type it. */
export const groupedSecret = (secret: string) => secret.replace(/(.{4})/g, '$1 ').trim()
