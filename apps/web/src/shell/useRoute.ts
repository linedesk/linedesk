// Where the app is, kept in the URL hash so reload and the browser's Back work:
// `#calls` (Needs you), `#calls/done` (another view), `#calls?q=leak` (search),
// `#calls/member/<user id>` (calls assigned to a member), `#call/<id>` (one call), `#assistant`, `#assistant/<section>`, `#account`, `#admin/<section>`.
// Old links to moved sections are rewritten (movedHash).
import { useCallback, useEffect, useRef, useState } from 'react'
import type { InboxTab } from '../inbox-model.ts'
import { hasSections, isPageRoute, type Route } from './pages.tsx'

/** `member`: whose calls the `member` view lists (null in every other view). */
export type InboxPlace = { tab: InboxTab; search: string | null; member?: string | null }
/** `known` is false when the hash names nothing the app has; the inbox shows instead. */
export type Location = InboxPlace & { route: Route; callId: string | null; known: boolean }

const CALL_PREFIX = 'call/'
const tabs: readonly InboxTab[] = ['you', 'ai', 'spam', 'reminders', 'done', 'mine', 'unassigned', 'review']
const HOME: InboxPlace = { tab: 'you', search: null, member: null }

export const callHash = (id: string) => `#${CALL_PREFIX}${id}`
export function listHash({ tab, search, member }: InboxPlace): string {
  const view = tab === 'member' && member ? `/member/${encodeURIComponent(member)}` : tab === 'you' || tab === 'member' ? '' : `/${tab}`
  return `#calls${view}${search === null ? '' : `?q=${encodeURIComponent(search)}`}`
}

function decode(value: string): string {
  try { return decodeURIComponent(value) } catch { return value }
}

/** `last` is the inbox view to keep while a call or another page is open (they do not carry it in the hash). */
export function parseHash(hash: string, last: InboxPlace = HOME): Location {
  const [path = '', query] = hash.replace(/^#/, '').split('?')
  if (path.startsWith(CALL_PREFIX) && path.length > CALL_PREFIX.length) return { ...last, route: 'calls', callId: path.slice(CALL_PREFIX.length), known: true }
  if (isPageRoute(path)) return { ...last, route: path, callId: null, known: true }
  // A section of a page (`#settings/recordings`), or of one of several things on it
  // (`#assistant/<assistant id>/hours`): the page reads which (ui/SettingsLayout.tsx).
  const [page = '', ...parts] = path.split('/')
  if (isPageRoute(page) && hasSections(page) && parts.length >= 1 && parts.length <= 2 && parts.every(p => /^[A-Za-z0-9_-]+$/.test(p)))
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

/**
 * Sections that moved: Business hours and Webhooks are in the assistant's settings, Notifications back in Settings;
 * Call details became Export calls; the assistant has a page of its own, not a Settings section.
 */
const MOVED: Record<string, string> = {
  'settings/assistant': 'assistant',
  'settings/hours': 'assistant/hours',
  'assistant/notifications': 'settings/notifications',
  'settings/fields': 'settings/export',
  'settings/webhooks': 'assistant/webhooks',
}

/** Where an old link now points (`#settings/hours` → `#assistant/hours`), or null when it did not move. */
export function movedHash(hash: string): string | null {
  const [path = '', query] = hash.replace(/^#/, '').split('?')
  const to = MOVED[path]
  return to ? `#${to}${query ? `?${query}` : ''}` : null
}

/** The hash, after rewriting an old link in place (Back skips the old one). */
function currentHash(): string {
  const moved = movedHash(window.location.hash)
  if (moved) window.history.replaceState(null, '', moved)
  return window.location.hash
}

/** A new history entry. */
const push = (hash: string) => { window.location.hash = hash }
/** The same history entry, so Back skips it. */
const replace = (hash: string) => window.history.replaceState(null, '', hash)

export function useRoute() {
  const [location, setLocation] = useState(() => parseHash(currentHash()))
  /** The latest location, also between a change and the next render (several changes can happen in one handler). */
  const current = useRef(location)
  /** True when the open call was reached from the inbox or a page in this tab, so closing it is a step back (to Contacts, say). */
  const openedFromList = useRef(false)
  const apply = useCallback((next: Location) => { current.current = next; setLocation(next) }, [])

  useEffect(() => {
    const onHash = () => apply(parseHash(currentHash(), current.current))
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [apply])

  const go = useCallback((to: Route) => {
    const now = current.current
    openedFromList.current = false // a page in between: closing a call later must not step back into it
    push(to === 'calls' ? listHash(now) : `#${to}`)
    apply({ ...now, route: to, callId: null, known: true })
  }, [apply])
  /** Change the inbox view or search. Replaces the entry: Back leaves the inbox, it does not step through views. */
  const setView = useCallback((place: InboxPlace) => {
    const now = current.current
    if (now.route === 'calls' && !now.callId) replace(listHash({ ...now, ...place }))
    apply({ ...now, ...place })
  }, [apply])
  /** Opening from the list adds a history entry; moving between calls replaces it, so Back returns to the list. */
  const openCall = useCallback((id: string) => {
    const now = current.current
    if (now.callId) replace(callHash(id))
    else { openedFromList.current = true; push(callHash(id)) }
    apply({ ...now, route: 'calls', callId: id, known: true })
  }, [apply])
  const closeCall = useCallback(() => {
    const now = current.current
    if (!now.callId) return
    if (openedFromList.current) { openedFromList.current = false; window.history.back() } // the hash follows on `hashchange`
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
