// Who is signed in, and what to do when the server cannot be reached at load. A member who
// was signed in on this device before opens the app from local data; anyone else waits for
// the server with automatic retries instead of a dead screen.
import { isSignedIn, type Me } from './auth.ts'
import { reach, Unreachable } from './retry.ts'

export type Session =
  | { state: 'loading' }
  | { state: 'signedOut' }
  | { state: 'needsWorkspace'; impersonation: Me['impersonation'] }
  /** `offline`: opened from what this device remembers, while the server is unreachable. */
  | { state: 'ready'; me: Me; offline: boolean }
  | { state: 'unreachable' }

const LAST_ME = 'callfront-last-me'

function remember(me: Me | null) {
  try {
    if (me) localStorage.setItem(LAST_ME, JSON.stringify(me))
    else localStorage.removeItem(LAST_ME)
  } catch { /* private window: then there is just no offline start */ }
}

function remembered(): Me | null {
  try {
    const me = JSON.parse(localStorage.getItem(LAST_ME) ?? 'null') as Me | null
    return me?.workspace ? me : null
  } catch { return null }
}

/** Forget the member this device remembers (on sign-out). */
export const forgetMe = () => remember(null)

export async function loadSession(): Promise<Session> {
  try {
    const res = await reach('/v1/me', { credentials: 'include' })
    const me = res.ok ? ((await res.json()) as Me) : null
    if (me?.workspace) { remember(me); return { state: 'ready', me, offline: false } }
    remember(null)
    // Signed in through a link or SSO for the first time: no workspace yet.
    if (me) return { state: 'needsWorkspace', impersonation: me.impersonation ?? null }
    return (await isSignedIn()) ? { state: 'needsWorkspace', impersonation: null } : { state: 'signedOut' }
  } catch (error) {
    if (!(error instanceof Unreachable)) throw error
    const me = remembered()
    return me ? { state: 'ready', me, offline: true } : { state: 'unreachable' }
  }
}
