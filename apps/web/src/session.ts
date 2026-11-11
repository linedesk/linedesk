// Who is signed in, and what to do when the server cannot be reached at load. A member who
// was signed in on this device before opens the app from local data; anyone else waits for
// the server with automatic retries instead of a dead screen.
import { isSignedIn, type Me } from './auth.ts'
import { forgetQueries, setQueryData, setQueryScope } from './cachedQuery.ts'
import { reach, Unreachable } from './retry.ts'
import { setTabWorkspace } from './tabWorkspace.ts'

export type Session =
  | { state: 'loading' }
  | { state: 'signedOut' }
  | { state: 'needsWorkspace'; impersonation: Me['impersonation'] }
  /** `offline`: opened from what this device remembers, while the server is unreachable. */
  | { state: 'ready'; me: Me; offline: boolean }
  | { state: 'unreachable' }

const LAST_ME = 'linedesk-last-me'

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

/** The cache key of the member's workspace list (WorkspaceSwitcher). */
export const WORKSPACES_QUERY = 'workspaces'

/**
 * Cached reads belong to this member in this workspace; the workspace list came along with /v1/me.
 * The workspace is this tab's from now on (tabWorkspace.ts).
 */
function primeQueries(me: Me) {
  setTabWorkspace(me.workspace?.id ?? null)
  setQueryScope(`${me.actorId}/${me.workspace?.id ?? ''}`)
  if (me.workspaces) setQueryData(WORKSPACES_QUERY, me.workspaces, { persist: true })
}

/** Forget the member this device remembers and what was cached for them (on sign-out). */
export function forgetMe() {
  remember(null)
  forgetQueries()
}

export async function loadSession(): Promise<Session> {
  try {
    const res = await reach('/v1/me', { credentials: 'include' })
    const me = res.ok ? ((await res.json()) as Me) : null
    if (me?.workspace) { remember(me); primeQueries(me); return { state: 'ready', me, offline: false } }
    remember(null)
    setTabWorkspace(null)
    // Signed in through a link or SSO for the first time: no workspace yet.
    if (me) return { state: 'needsWorkspace', impersonation: me.impersonation ?? null }
    return (await isSignedIn()) ? { state: 'needsWorkspace', impersonation: null } : { state: 'signedOut' }
  } catch (error) {
    if (!(error instanceof Unreachable)) throw error
    const me = remembered()
    if (!me) return { state: 'unreachable' }
    primeQueries(me)
    return { state: 'ready', me, offline: true }
  }
}
