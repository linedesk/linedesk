// Who is signed in, and what to do when the server cannot be reached at load. A member who
// was signed in on this device before opens the app from local data at once, while /v1/me is
// asked (rememberedSession); anyone else waits for the server, with automatic retries instead
// of a dead screen while it cannot be reached.
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
  /**
   * The API answered 421: this address is not set up (a white-label partner's address that is not live, or any other
   * name pointed at the server). `mainOrigin`: the install's own address, to link to; null when it did not say.
   */
  | { state: 'hostNotSetUp'; mainOrigin: string | null }

const LAST_ME = 'linedesk-last-me'
const CHANGING_KEY = 'linedesk.sessionChanging'

function remember(me: Me | null) {
  try {
    if (me) localStorage.setItem(LAST_ME, JSON.stringify(me))
    else localStorage.removeItem(LAST_ME)
  } catch { /* private window: then there is just no offline start */ }
}

/** What this device remembers and whether a session change is under way, to tell a stale /v1/me answer (loadSession). */
function deviceState(): string {
  try {
    return `${localStorage.getItem(LAST_ME)}|${sessionStorage.getItem(CHANGING_KEY)}`
  } catch {
    return ''
  }
}

function remembered(): Me | null {
  try {
    const me = JSON.parse(localStorage.getItem(LAST_ME) ?? 'null') as Me | null
    return me?.workspace ? me : null
  } catch { return null }
}


/**
 * This tab is about to change whose or which workspace it opens (a switch, leaving or deleting the workspace): the
 * next load waits for /v1/me instead of opening the workspace this device remembers. Cleared by the server's answer.
 */
export function expectSessionChange() {
  try {
    sessionStorage.setItem(CHANGING_KEY, '1')
  } catch {}
}

function sessionChanging(): boolean {
  try {
    return sessionStorage.getItem(CHANGING_KEY) !== null
  } catch {
    return false
  }
}

function sessionChanged() {
  try {
    sessionStorage.removeItem(CHANGING_KEY)
  } catch {}
}

/** The cache key of the member's workspace list (WorkspaceSwitcher). */
export const WORKSPACES_QUERY = 'workspaces'
/** The cache key of the partners the person is on the team of (partner/partner-api.ts). */
export const PARTNERS_QUERY = 'partners.mine'

/**
 * Cached reads belong to this member in this workspace; the workspace list came along with /v1/me.
 * The workspace is this tab's from now on (tabWorkspace.ts).
 */
function primeQueries(me: Me) {
  setTabWorkspace(me.workspace?.id ?? null, me.actorId)
  setQueryScope(`${me.actorId}/${me.workspace?.id ?? ''}`)
  if (me.workspaces) setQueryData(WORKSPACES_QUERY, me.workspaces, { persist: true })
  setQueryData(PARTNERS_QUERY, [...(me.partners ?? []), ...(me.partnersElsewhere ?? [])])
}

/**
 * The workspace was renamed here (onboarding's business step): `me` with the new name, and the cached workspace list
 * and the remembered `me` changed with it, so the menu shows the name right away.
 */
export function renamedWorkspace(me: Me, name: string): Me {
  const id = me.workspace?.id
  const rename = (list: { id: string; name: string }[]) => list.map(w => (w.id === id ? { ...w, name } : w))
  const next: Me = {
    ...me,
    // Named now: no longer the sign-up's placeholder.
    workspace: me.workspace && { ...me.workspace, name, unnamed: false },
    ...(me.workspaces ? { workspaces: rename(me.workspaces) } : {}),
  }
  setQueryData<{ id: string; name: string }[]>(WORKSPACES_QUERY, list => rename(list ?? next.workspaces ?? []), {
    persist: true,
  })
  remember(next)
  return next
}

/**
 * The session on screen with its workspace renamed, or null when no workspace is open. Call it from the event, never
 * inside a state updater: renamedWorkspace updates the cached workspace list, and its subscribers (WorkspaceMenu)
 * must not be updated while App renders ("Cannot update a component while rendering a different component").
 */
export function renameInSession(current: Session, name: string): Session | null {
  return current.state === 'ready' ? { ...current, me: renamedWorkspace(current.me, name) } : null
}

/**
 * The workspace's icon changed here (Workspace settings › General): the cached workspace list, which the workspace
 * button, the switcher and the tab icon read, and the remembered `me` show the new one at once.
 */
export function changedWorkspaceIcon(id: string, iconUrl: string | null) {
  type Listed = { id: string; name: string; iconUrl?: string | null }
  const withIcon = <T extends Listed>(list: T[]) => list.map(w => (w.id === id ? { ...w, iconUrl } : w))
  const before = remembered()
  setQueryData<Listed[]>(WORKSPACES_QUERY, list => withIcon(list ?? before?.workspaces ?? []), { persist: true })
  if (before)
    remember({
      ...before,
      workspace: before.workspace?.id === id ? { ...before.workspace, iconUrl } : before.workspace,
      ...(before.workspaces ? { workspaces: withIcon(before.workspaces) } : {}),
    })
}

/** Forget the member this device remembers and what was cached for them (on sign-out). */
export function forgetMe() {
  remember(null)
  forgetQueries()
}

const LEFT_KEY = 'linedesk.leftWorkspace'
/** Set with LEFT_KEY when the person's account went with leaving (their last workspace, "Also delete my account"). */
const LEFT_DELETED_KEY = 'linedesk.leftAccountDeleted'

/**
 * Before leaving a workspace on purpose: the screen after it says "You left …", not "You no longer have access".
 * `accountDeleted`: the account went too, so the sign-in page says so (leftAndDeleted).
 */
export function markLeft({ accountDeleted = false }: { accountDeleted?: boolean } = {}) {
  expectSessionChange()
  const name = remembered()?.workspace?.name
  try {
    if (name) sessionStorage.setItem(LEFT_KEY, name)
    if (accountDeleted) sessionStorage.setItem(LEFT_DELETED_KEY, '1')
    else sessionStorage.removeItem(LEFT_DELETED_KEY)
  } catch {}
}

/** The workspace this tab left with its account deleted (markLeft), for the sign-in page; null otherwise. */
export function leftAndDeleted(): string | null {
  try {
    return sessionStorage.getItem(LEFT_DELETED_KEY) === '1' ? sessionStorage.getItem(LEFT_KEY) : null
  } catch { return null }
}


/** Whether this tab left the workspace of that name itself (markLeft). */
export function leftOnPurpose(workspaceName: string | null): boolean {
  try {
    return !!workspaceName && sessionStorage.getItem(LEFT_KEY) === workspaceName
  } catch {
    return false
  }
}

const DELETED_KEY = 'linedesk.deletedWorkspace'
/** What this tab deleted: the workspace's name, and whether the owner's own account went with it. */
export type Deleted = { name: string; accountDeleted: boolean }

/** After an owner deleted the workspace: the next screen says so (a toast, the no-workspace or sign-in page). */
export function markDeleted(deleted: Deleted) {
  expectSessionChange()
  try {
    sessionStorage.setItem(DELETED_KEY, JSON.stringify(deleted))
  } catch {}
}

/** What this tab deleted, without forgetting it (markDeleted). */
export function readDeleted(): Deleted | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(DELETED_KEY) ?? 'null') as Partial<Deleted> | null
    return typeof value?.name === 'string' ? { name: value.name, accountDeleted: value.accountDeleted === true } : null
  } catch { return null }
}


/** What this tab deleted, once: read and forgotten (the toast, the sign-in page). */
export function takeDeleted(): Deleted | null {
  const deleted = readDeleted()
  try {
    sessionStorage.removeItem(DELETED_KEY)
  } catch {}
  return deleted
}

/** Whether this tab deleted the workspace of that name itself (markDeleted): "You deleted …", not "no access". */
export const deletedOnPurpose = (workspaceName: string | null) =>
  !!workspaceName && readDeleted()?.name === workspaceName

function forgetLeft() {
  try {
    sessionStorage.removeItem(LEFT_KEY)
    sessionStorage.removeItem(LEFT_DELETED_KEY)
  } catch {}
}

/** The workspace this browser had open before its member lost access to it, and whose it was (see loadSession). */
let lost: { account: string; name: string } | null = null

/** The lost workspace's name, only for the person it was lost by: never another account's workspace name. */
const lostBy = (account: string | null) => (account && lost?.account === account ? lost.name : null)

/**
 * The workspace this device was signed in to when the server ended its session before its time, and nobody is
 * signed in now. The sign-in page says so (Login.tsx). The server does not say why (a removal, a password change,
 * "Sign out other sessions", a disabled account all look the same here), so the words stay neutral: "signed out",
 * never "your access ended". Kept only in this page's memory, and forgotten once anyone signs in.
 */
let signedOutOf: string | null = null

/** "You were signed out of <workspace>." on the sign-in page: the workspace's name, or null. */
export const signedOutOfWorkspace = () => signedOutOf

/** A session that was still running when the server stopped knowing it, so it ended early, not by its own time. */
const endedEarly = (me: Me, now: number) => !!me.sessionExpiresAt && Date.parse(me.sessionExpiresAt) > now

type Ready = Extract<Session, { state: 'ready' }>

/**
 * The session this device remembers, to open its workspace at once from local data while /v1/me is asked
 * (loadSession, whose answer then replaces it). Null when the app waits for that answer instead: nobody is
 * remembered, the remembered session has ended (or is from a version that did not say when it ends), the address
 * links to another workspace (`linked`), or the next screen would not be the workspace (impersonation, onboarding,
 * this tab changing its session: expectSessionChange).
 */
export function rememberedSession(linked: string | null = null, now = Date.now()): Ready | null {
  const me = remembered()
  if (!me?.workspace || me.impersonation || me.onboarding || sessionChanging()) return null
  if (!me.sessionExpiresAt || !(Date.parse(me.sessionExpiresAt) > now)) return null
  if (linked && linked !== me.workspace.id) return null
  primeQueries(me)
  return { state: 'ready', me, offline: false }
}

/** Whether `next` is what `shown` already shows (the same member, workspace and permissions, both online). */
export function sameSession(shown: Session, next: Session): boolean {
  return (
    shown.state === 'ready' &&
    next.state === 'ready' &&
    !shown.offline &&
    !next.offline &&
    JSON.stringify(shown.me) === JSON.stringify(next.me)
  )
}

/** The API's answer on an address that is not set up (apps/api/src/request-host.ts). */
const HOST_NOT_SET_UP = 421

/** The install's own origin from a 421 answer, only when it is an http(s) origin. */
export async function mainOriginOf(res: Response): Promise<string | null> {
  const body = (await res.json().catch(() => null)) as { mainOrigin?: unknown } | null
  if (typeof body?.mainOrigin !== 'string') return null
  try {
    const url = new URL(body.mainOrigin)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null
  } catch { return null }
}


/**
 * `partners`: those whose area opens here. On a white-label partner's own address the server lists that partner with
 * `areaOrigin` (S5): its area opens at the install's own address, so only the menus show it (`partnersElsewhere`).
 */
export function partnersHere(me: Me): Me {
  if (!me.partners?.some(p => p.areaOrigin)) return me
  const all = [...me.partners, ...(me.partnersElsewhere ?? [])]
  return { ...me, partners: all.filter(p => !p.areaOrigin), partnersElsewhere: all.filter(p => p.areaOrigin) }
}

export async function loadSession(): Promise<Session> {
  const asked = deviceState()
  try {
    const res = await reach('/v1/me', { credentials: 'include' })
    // Before anything is remembered or forgotten: on an address that is not set up, nothing here is this server's.
    if (res.status === HOST_NOT_SET_UP) return { state: 'hostNotSetUp', mainOrigin: await mainOriginOf(res) }
    // Signed out, switched or another answer remembered while this one was on its way: it must not undo that.
    const current = deviceState() === asked
    if (current) sessionChanged()
    const me = res.ok ? partnersHere((await res.json()) as Me) : null
    if (me?.workspace) {
      signedOutOf = null
      if (current) remember(me)
      primeQueries(me)
      forgetLeft()
      return { state: 'ready', me, offline: false }
    }
    // This browser had a workspace open before: its member was removed from it (or from their last one).
    // Kept for this page, as the remembered member is forgotten right below (a second load must say it too).
    const before = remembered()
    if (before?.workspace) lost = { account: before.actorId, name: before.workspace.name }
    remember(null)
    setTabWorkspace(null)
    // Signed in through a link or SSO for the first time: no workspace yet.
    if (me) {
      signedOutOf = null
      return { state: 'needsWorkspace', impersonation: me.impersonation ?? null, me, lostWorkspace: lostBy(me.actorId) }
    }
    const account = await signedInAccount()
    if (account) {
      signedOutOf = null
      return { state: 'needsWorkspace', impersonation: null, me: null, lostWorkspace: lostBy(account) }
    }
    // Signed out although the remembered session had not run out: the server ended it, for whatever reason (A7).
    if (before?.workspace && endedEarly(before, Date.now())) signedOutOf = before.workspace.name
    return { state: 'signedOut' }
  } catch (error) {
    if (!(error instanceof Unreachable)) throw error
    const me = remembered()
    if (!me) return { state: 'unreachable' }
    primeQueries(me)
    return { state: 'ready', me, offline: true }
  }
}
