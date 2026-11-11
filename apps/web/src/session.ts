// Who is signed in, and what to do when the server cannot be reached at load. A member who
// was signed in on this device before opens the app from local data; anyone else waits for
// the server with automatic retries instead of a dead screen.
import { type Me, signedInAccount } from './auth.ts'
import { forgetQueries, setQueryData, setQueryScope } from './cachedQuery.ts'
import { reach, Unreachable } from './retry.ts'
import { setTabWorkspace } from './tabWorkspace.ts'

export type Session =
  | { state: 'loading' }
  | { state: 'signedOut' }
  /**
   * `me`: what /v1/me said (an instance admin without a workspace); null when it did not answer for this person.
   * `lostWorkspace`: the workspace this browser had open for this same person, which they no longer belong to.
   */
  | { state: 'needsWorkspace'; impersonation: Me['impersonation']; me: Me | null; lostWorkspace: string | null }
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
  setTabWorkspace(me.workspace?.id ?? null, me.actorId)
  setQueryScope(`${me.actorId}/${me.workspace?.id ?? ''}`)
  if (me.workspaces) setQueryData(WORKSPACES_QUERY, me.workspaces, { persist: true })
}

/** Forget the member this device remembers and what was cached for them (on sign-out). */
export function forgetMe() {
  remember(null)
  forgetQueries()
}

const LEFT_KEY = 'linedesk.leftWorkspace'

/** Before leaving a workspace on purpose: the screen after it says "You left …", not "You no longer have access". */
export function markLeft() {
  const name = remembered()?.workspace?.name
  try {
    if (name) sessionStorage.setItem(LEFT_KEY, name)
  } catch {}
}

/** Whether this tab left the workspace of that name itself (markLeft). */
export function leftOnPurpose(workspaceName: string | null): boolean {
  try {
    return !!workspaceName && sessionStorage.getItem(LEFT_KEY) === workspaceName
  } catch {
    return false
  }
}

function forgetLeft() {
  try {
    sessionStorage.removeItem(LEFT_KEY)
  } catch {}
}

/** The workspace this browser had open before its member lost access to it, and whose it was (see loadSession). */
let lost: { account: string; name: string } | null = null

/** The lost workspace's name, only for the person it was lost by: never another account's workspace name. */
const lostBy = (account: string | null) => (account && lost?.account === account ? lost.name : null)

export async function loadSession(): Promise<Session> {
  try {
    const res = await reach('/v1/me', { credentials: 'include' })
    const me = res.ok ? ((await res.json()) as Me) : null
    if (me?.workspace) { remember(me); primeQueries(me); forgetLeft(); return { state: 'ready', me, offline: false } }
    // This browser had a workspace open before: its member was removed from it (or from their last one).
    // Kept for this page, as the remembered member is forgotten right below (a second load must say it too).
    const before = remembered()
    if (before?.workspace) lost = { account: before.actorId, name: before.workspace.name }
    remember(null)
    setTabWorkspace(null)
    // Signed in through a link or SSO for the first time: no workspace yet.
    if (me) return { state: 'needsWorkspace', impersonation: me.impersonation ?? null, me, lostWorkspace: lostBy(me.actorId) }
    const account = await signedInAccount()
    return account ? { state: 'needsWorkspace', impersonation: null, me: null, lostWorkspace: lostBy(account) } : { state: 'signedOut' }
  } catch (error) {
    if (!(error instanceof Unreachable)) throw error
    const me = remembered()
    if (!me) return { state: 'unreachable' }
    primeQueries(me)
    return { state: 'ready', me, offline: true }
  }
}
