// Where the app is, kept in the URL hash so reload and the browser's Back work:
// `#calls` (Needs you), `#calls/done` (another view), `#calls?q=leak` (search),
// `#calls/member/<user id>` (calls assigned to a member), `#call/<id>` (one call), `#assistant`, `#assistant/<section>`, `#workspace/<section>`, `#account`, `#admin/<section>`.
// Old links to moved sections are rewritten (movedHash). A link from an email names its workspace
// (`#call/<id>?ws=<workspace id>`); the app switches to it before the page opens (linkWorkspaceTarget).
import { useCallback, useEffect, useRef, useState } from 'react'
import type { InboxTab } from '../inbox-model.ts'
import { hasSections, isPageRoute, type Route } from './pages.tsx'

/** `member`: whose calls the `member` view lists (null in every other view). */
export type InboxPlace = { tab: InboxTab; search: string | null; member?: string | null }
/** `known` is false when the hash names nothing the app has; the inbox shows instead. */
export type Location = InboxPlace & { route: Route; callId: string | null; known: boolean }
/** Open a page, or one section of it (`go('workspace', 'team')` → `#workspace/team`); a new history entry. */
export type Go = (to: Route, section?: string) => void

const CALL_PREFIX = 'call/'
const tabs: readonly InboxTab[] = ['you', 'ai', 'spam', 'reminders', 'done', 'mine', 'unassigned']
const HOME: InboxPlace = { tab: 'you', search: null, member: null }

export const callHash = (id: string) => `#${CALL_PREFIX}${id}`
export function listHash({ tab, search, member }: InboxPlace): string {
  const view =
    tab === 'member' && member
      ? `/member/${encodeURIComponent(member)}`
      : tab === 'you' || tab === 'member'
        ? ''
        : `/${tab}`
  return `#calls${view}${search === null ? '' : `?q=${encodeURIComponent(search)}`}`
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** `last` is the inbox view to keep while a call or another page is open (they do not carry it in the hash). */
export function parseHash(hash: string, last: InboxPlace = HOME): Location {
  const [path = '', query] = hash.replace(/^#/, '').split('?')
  if (path.startsWith(CALL_PREFIX) && path.length > CALL_PREFIX.length)
    return { ...last, route: 'calls', callId: path.slice(CALL_PREFIX.length), known: true }
  if (isPageRoute(path)) return { ...last, route: path, callId: null, known: true }
  // A section of a page (`#workspace/recordings`), or of one of several things on it
  // (`#assistant/<assistant id>/hours`): the page reads which (ui/SettingsLayout.tsx).
  const [page = '', ...parts] = path.split('/')
  if (
    isPageRoute(page) &&
    hasSections(page) &&
    parts.length >= 1 &&
    parts.length <= 2 &&
    parts.every(p => /^[A-Za-z0-9_-]+$/.test(p))
  )
    return { ...last, route: page, callId: null, known: true }
  // Admin mode has sections of its own (`#admin/users/<id>`); admin/route.ts reads them.
  if (path.startsWith('admin/')) return { ...last, route: 'admin', callId: null, known: true }
  const params = query?.split('&') ?? []
  const param = (name: string) => {
    const found = params.find(p => p.startsWith(`${name}=`))
    return found === undefined ? null : decode(found.slice(name.length + 1))
  }
  // The search rides along in every list view, a member's included.
  const filters = { search: param('q') }
  const [head, view = 'you', ...rest] = path.split('/')
  if (head === 'calls' && view === 'member' && rest.length === 1 && rest[0])
    return { route: 'calls', callId: null, tab: 'member', member: decode(rest[0]), ...filters, known: true }
  const isList = (head === 'calls' || path === '') && tabs.includes(view as InboxTab) && rest.length === 0
  if (!isList) return { ...HOME, route: 'calls', callId: null, known: false }
  return { route: 'calls', callId: null, tab: view as InboxTab, member: null, ...filters, known: true }
}

/** The hash parameter a link names its workspace with (the API's appLink, apps/api/src/emails/templates.ts). */
const WORKSPACE_PARAM = 'ws'

const splitHash = (hash: string) => {
  const [path = '', ...rest] = hash.replace(/^#/, '').split('?')
  return { path, params: rest.join('?').split('&').filter(Boolean) }
}

/** The workspace a link is for (`#call/<id>?ws=<id>`), or null when it names none. */
export function linkWorkspace(hash: string): string | null {
  const found = splitHash(hash).params.find(p => p.startsWith(`${WORKSPACE_PARAM}=`))
  const id = found ? decode(found.slice(WORKSPACE_PARAM.length + 1)) : ''
  return id || null
}

/** The hash without its workspace (`#call/<id>?ws=<id>` → `#call/<id>`); the rest of it as it was. */
export function withoutLinkWorkspace(hash: string): string {
  const { path, params } = splitHash(hash)
  const kept = params.filter(p => !p.startsWith(`${WORKSPACE_PARAM}=`))
  return `#${path}${kept.length ? `?${kept.join('&')}` : ''}`
}

type Named = { id: string; name: string }
/**
 * What opening a link for `linked` does in a tab on `current`: stay (`here`), switch the session to it and
 * reload (`switch`, the member belongs to it), or not: `elsewhere` when they belong to it but cannot switch now
 * (offline), `noAccess` when they don't (the inbox opens and says so).
 */
export type LinkTarget =
  | { kind: 'here' }
  | { kind: 'switch'; workspace: Named }
  | { kind: 'elsewhere'; workspace: Named }
  | { kind: 'noAccess' }

export function linkWorkspaceTarget(
  linked: string,
  current: string,
  mine: readonly Named[] | undefined,
  offline = false,
): LinkTarget {
  if (linked === current) return { kind: 'here' }
  const workspace = mine?.find(w => w.id === linked)
  if (!workspace) return { kind: 'noAccess' }
  return offline ? { kind: 'elsewhere', workspace } : { kind: 'switch', workspace }
}

/** What the inbox says after a link it could not open in this workspace. */
export function linkNotice(target: LinkTarget): string | null {
  if (target.kind === 'noAccess') return "You don't have access to the workspace that link is for."
  if (target.kind === 'elsewhere')
    return `That link is for ${target.workspace.name}. Switch to it in the workspace menu.`
  return null
}

/**
 * Old links, exact paths first. Settings became Workspace settings (Team is a section of it), your notifications
 * are in Account, Business hours and Webhooks in the assistant's settings, Call details became Export calls, Needs
 * review became How <assistant> did.
 */
const MOVED: Record<string, string> = {
  settings: 'workspace',
  'settings/assistant': 'assistant',
  'settings/hours': 'assistant/hours',
  'settings/webhooks': 'assistant/webhooks',
  'settings/fields': 'workspace/export',
  'settings/notifications': 'account/notifications',
  'assistant/notifications': 'account/notifications',
  team: 'workspace/team',
  // Needs review left the inbox: How <assistant> did, in the Assistant area.
  'calls/review': 'assistant/review',
}

/** Where an old path now points, by MOVED and then by its first parts; null when it did not move. */
function movedPath(path: string): string | null {
  if (Object.hasOwn(MOVED, path)) return MOVED[path]!
  const [head, ...rest] = path.split('/')
  if (head === 'team') return 'workspace/team'
  // The assistant's notifications (`#assistant/<id>/notifications`) were always your own.
  if (head === 'assistant' && rest.length === 2 && rest[1] === 'notifications') return 'account/notifications'
  // Phone numbers (also one number), recordings, export, developers and unknown sections: the same place in
  // Workspace settings; an unknown one then shows General (knownSectionHash).
  if (head === 'settings' && rest.length > 0) return `workspace/${rest.join('/')}`
  return null
}

/**
 * Where an old link now points (`#settings/phone/<id>?ws=<id>` → `#workspace/phone/<id>?ws=<id>`), the query kept,
 * or null when it did not move. Every target is a current place, so a rewritten link is never rewritten again.
 */
export function movedHash(hash: string): string | null {
  const [path = '', ...rest] = hash.replace(/^#/, '').split('?')
  const to = movedPath(path)
  const query = rest.join('?')
  return to === null ? null : `#${to}${query ? `?${query}` : ''}`
}

/** The hash, after rewriting an old link in place (Back skips the old one). */
function currentHash(): string {
  const moved = movedHash(window.location.hash)
  if (moved) window.history.replaceState(null, '', moved)
  return window.location.hash
}

/** The parts of `window` the address helpers below use (a stand-in in tests). */
type Address = { location: { pathname: string; search: string }; history: { replaceState: History['replaceState'] } }

/** The address without the in-app route (signing out): the next account to sign in here starts in the inbox. */
export function clearRoute(win: Address = window) {
  win.history.replaceState(null, '', `${win.location.pathname}${win.location.search}`)
}

/** A new history entry. */
const push = (hash: string) => {
  window.location.hash = hash
}
/** The same history entry, so Back skips it. */
const replace = (hash: string) => window.history.replaceState(null, '', hash)

export function useRoute() {
  const [location, setLocation] = useState(() => parseHash(currentHash()))
  /** The latest location, also between a change and the next render (several changes can happen in one handler). */
  const current = useRef(location)
  /** True when the open call was reached from the inbox or a page in this tab, so closing it is a step back (to Contacts, say). */
  const openedFromList = useRef(false)
  const apply = useCallback((next: Location) => {
    current.current = next
    setLocation(next)
  }, [])

  useEffect(() => {
    const onHash = () => apply(parseHash(currentHash(), current.current))
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [apply])

  const go: Go = useCallback(
    (to, section) => {
      const now = current.current
      openedFromList.current = false // a page in between: closing a call later must not step back into it
      push(to === 'calls' ? listHash(now) : `#${to}${section ? `/${section}` : ''}`)
      apply({ ...now, route: to, callId: null, known: true })
    },
    [apply],
  )
  /** Change the inbox view or search. Replaces the entry: Back leaves the inbox, it does not step through views. */
  const setView = useCallback(
    (place: InboxPlace) => {
      const now = current.current
      if (now.route === 'calls' && !now.callId) replace(listHash({ ...now, ...place }))
      apply({ ...now, ...place })
    },
    [apply],
  )
  /** Opening from the list adds a history entry; moving between calls replaces it, so Back returns to the list. */
  const openCall = useCallback(
    (id: string) => {
      const now = current.current
      if (now.callId) replace(callHash(id))
      else {
        openedFromList.current = true
        push(callHash(id))
      }
      apply({ ...now, route: 'calls', callId: id, known: true })
    },
    [apply],
  )
  const closeCall = useCallback(() => {
    const now = current.current
    if (!now.callId) return
    if (openedFromList.current) {
      openedFromList.current = false
      window.history.back()
    } // the hash follows on `hashchange`
    else replace(listHash(now))
    apply({ ...now, callId: null }) // at once, so nothing renders a call that is already closed
  }, [apply])
  /** Drop a hash that leads nowhere (an unknown page or a call that does not exist). */
  const backToInbox = useCallback(() => {
    const now = current.current
    openedFromList.current = false
    replace(listHash(now))
    apply({ ...now, route: 'calls', callId: null, known: true })
  }, [apply])

  return { ...location, go, setView, openCall, closeCall, backToInbox }
}
export type RouteApi = ReturnType<typeof useRoute>
