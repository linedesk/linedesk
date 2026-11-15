// Reads that are not in the local store (workspace settings, team, account, admin, the workspace
// list): shown at once from the last answer and refreshed in the background, like the inbox. A
// query is loaded once and shared by every component that uses it; it is checked again when a
// component that shows it mounts, when the window gets focus or the tab is shown again, and on
// refreshQuery() (call it, or setQueryData, right after a write that changes the answer). With
// `persist`, the last answer is kept in localStorage too, so the next page load shows it at once.
// Everything is kept per signed-in member and workspace (setQueryScope) and forgotten on sign-out.
import { useCallback, useEffect, useSyncExternalStore } from 'react'

export type QueryState<T> = {
  /** The last answer; undefined until the first one arrives. */
  data: T | undefined
  /** Why the last load failed; the last answer, if any, stays. */
  error: string | null
}
export type Query<T> = QueryState<T> & { reload: () => Promise<void> }
/**
 * `freshMs`: how long an answer counts as fresh, so mounting or focus does not load it again (default 5 s).
 * `idle`: the answer is settled; it is shown and kept, but only loaded again on refreshQuery().
 */
type Options = { persist?: boolean; freshMs?: number; idle?: boolean }

/** One query's answer for the current member and workspace (setQueryScope); a new scope starts new entries. */
type Entry = {
  state: QueryState<unknown>
  persist: boolean
  loadedAt: number
  /** How often the page put an answer in place itself (setQueryData). */
  changes: number
  /** The load whose answer counts: an earlier one still on its way is dropped when it lands (reload). */
  latest: number
  inflight?: Promise<void>
}

/**
 * What a query is, across scopes: how it loads and who shows it. Kept apart from the answers, so a scope change or a
 * sign-out that drops the answers never loses a loader or a screen's subscription (a screen that stayed on "Loading"
 * with "Try again" doing nothing: LIN-266).
 */
type Registration = {
  load?: () => Promise<unknown>
  freshMs: number
  idle: boolean
  listeners: Set<() => void>
}

const STORAGE_PREFIX = 'linedesk-q:'
/** A query that was loaded this recently is not loaded again when another component mounts. */
const FRESH_MS = 5_000
const EMPTY: QueryState<never> = { data: undefined, error: null }

const entries = new Map<string, Entry>()
const registrations = new Map<string, Registration>()
let scope = ''

const storageKey = (key: string) => `${STORAGE_PREFIX}${scope}:${key}`

function readStored(key: string): unknown {
  try {
    const raw = localStorage.getItem(storageKey(key))
    return raw === null ? undefined : JSON.parse(raw)
  } catch {
    return undefined // private window or a broken value: then there is just nothing to show early
  }
}

function writeStored(key: string, data: unknown) {
  try {
    localStorage.setItem(storageKey(key), JSON.stringify(data))
  } catch {
    /* full or unavailable: the answer is still kept in memory */
  }
}

function entryFor(key: string, persist = false): Entry {
  let entry = entries.get(key)
  if (!entry) {
    const stored = persist ? readStored(key) : undefined
    entry = {
      state: stored === undefined ? EMPTY : { data: stored, error: null },
      persist,
      loadedAt: 0,
      changes: 0,
      latest: 0,
    }
    entries.set(key, entry)
  }
  if (persist && !entry.persist) entry.persist = true
  return entry
}

function registrationFor(key: string): Registration {
  let registration = registrations.get(key)
  if (!registration) {
    registration = { freshMs: FRESH_MS, idle: false, listeners: new Set() }
    registrations.set(key, registration)
  }
  return registration
}

const shownKeys = () => [...registrations].filter(([, r]) => r.listeners.size > 0).map(([key]) => key)

function notify(key: string) {
  for (const listener of registrations.get(key)?.listeners ?? []) listener()
}

function publish(key: string, entry: Entry, state: QueryState<unknown>) {
  entry.state = state
  if (entry.persist && state.data !== undefined) writeStored(key, state.data)
  notify(key)
}

/**
 * Drops every answer in memory. A query that is on screen stays subscribed: it shows the new scope's answer (empty, or
 * the stored one) at once and loads again; an answer of the old scope still on its way is dropped when it lands.
 */
function dropAnswers() {
  const shown = shownKeys().map(key => [key, entries.get(key)?.persist ?? false] as const)
  entries.clear()
  for (const [key, persist] of shown) {
    entryFor(key, persist)
    notify(key)
    void fetchQuery(key)
  }
}

/**
 * The member and workspace the cached answers belong to. Changing it starts with an empty memory;
 * persisted answers of the new scope are read when they are first used. A query that is on screen
 * stays subscribed: it shows the new scope's answer (empty, or the stored one) at once and loads again.
 */
export function setQueryScope(next: string) {
  if (next === scope) return
  scope = next
  dropAnswers()
}

/**
 * Loads the query now and shares the answer. A load already on its way is joined, unless `again` (the person asked
 * to try again): then a new load starts and only its answer counts. A failure keeps the last answer.
 */
export function fetchQuery<T>(
  key: string,
  load?: () => Promise<T>,
  options: Options = {},
  again = false,
): Promise<void> {
  const entry = entryFor(key, options.persist)
  const registration = registrationFor(key)
  if (load) registration.load = load
  if (entry.inflight && !again) return entry.inflight
  const run = registration.load
  if (!run) return Promise.resolve()
  const changesBefore = entry.changes
  const id = ++entry.latest
  // Still the answer that counts: the same scope (no sign-out or switch since), no newer load, no change the page made
  // since (an answer the server gave before it would undo that change on screen).
  const counts = () => entries.get(key) === entry && entry.latest === id && entry.changes === changesBefore
  const settled = run().then(
    data => {
      if (counts()) publish(key, entry, { data, error: null })
    },
    (err: unknown) => {
      if (counts())
        publish(key, entry, { data: entry.state.data, error: err instanceof Error ? err.message : String(err) })
    },
  )
  const inflight = settled.finally(() => {
    if (entry.latest !== id) return
    entry.inflight = undefined
    entry.loadedAt = Date.now()
  })
  entry.inflight = inflight
  return inflight
}

/** Loads the query again in the background, if anything has loaded it before. */
export const refreshQuery = (key: string) => fetchQuery(key)

/** Puts an answer in place without asking the server: after a change the page made itself, or data that came along with another answer. */
export function setQueryData<T>(key: string, update: T | ((previous: T | undefined) => T), options: Options = {}) {
  const entry = entryFor(key, options.persist)
  const data =
    typeof update === 'function' ? (update as (p: T | undefined) => T)(entry.state.data as T | undefined) : update
  entry.loadedAt = Date.now()
  entry.changes++
  publish(key, entry, { data, error: null })
}

/** The answer the cache has right now, without loading. */
export const peekQuery = <T>(key: string): T | undefined => entries.get(key)?.state.data as T | undefined

/** The same, including an answer kept in localStorage that nothing has used yet in this page (`persist`). */
export const peekStoredQuery = <T>(key: string): T | undefined => entryFor(key, true).state.data as T | undefined

/**
 * On sign-out: drops every answer of every member on this device, in memory and in localStorage.
 * Answers without a member (what the sign-in page shows) stay.
 */
export function forgetQueries() {
  scope = ''
  const signedOut = storageKey('')
  try {
    for (const key of Object.keys(localStorage))
      if (key.startsWith(STORAGE_PREFIX) && !key.startsWith(signedOut)) localStorage.removeItem(key)
  } catch {
    /* nothing was stored */
  }
  // Also when the scope stays '' (an instance admin without a workspace, whose Server admin is on screen while the
  // page forgets what it kept: localData.ts forgetBeyond): what is shown keeps its place and loads again.
  dropAnswers()
}

/** Another account signed in on this browser: the answers stored for every other member go; this member's stay. */
export function forgetOtherMembersQueries(actorId: string) {
  const signedOut = `${STORAGE_PREFIX}:` // what the sign-in page shows
  const own = `${STORAGE_PREFIX}${actorId}/`
  try {
    for (const key of Object.keys(localStorage))
      if (key.startsWith(STORAGE_PREFIX) && !key.startsWith(signedOut) && !key.startsWith(own))
        localStorage.removeItem(key)
  } catch {
    /* nothing was stored */
  }
}

/** Queries someone is looking at are checked again when the window gets focus back (not right after a load). */
function refreshShown() {
  const now = Date.now()
  for (const key of shownKeys()) {
    const { idle, freshMs } = registrationFor(key)
    if (!idle && now - entryFor(key).loadedAt > freshMs) void fetchQuery(key)
  }
}
if (typeof window !== 'undefined') {
  window.addEventListener('focus', refreshShown)
  // A tab shown again (switching tabs does not always move the window's focus).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshShown()
  })
}

/** Calls `listener` whenever the query's answer changes (what a component showing it does); returns the unsubscribe. */
export function subscribeQuery(key: string, listener: () => void, options: Options = {}): () => void {
  entryFor(key, options.persist)
  const { listeners } = registrationFor(key)
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The query's state right now, without loading. */
export const queryState = <T>(key: string, options: Options = {}): QueryState<T> =>
  entryFor(key, options.persist).state as QueryState<T>

/**
 * A query's last answer, at once, and a fresh one in the background. `key` names what is loaded
 * (one key, one loader); null loads nothing.
 */
export function useQuery<T>(key: string | null, load: () => Promise<T>, options: Options = {}): Query<T> {
  const subscribe = useCallback(
    (listener: () => void) => (key ? subscribeQuery(key, listener, { persist: options.persist }) : () => {}),
    [key, options.persist],
  )
  const snapshot = () => (key ? queryState(key, { persist: options.persist }) : EMPTY)
  // The same snapshot when rendered to markup (tests that render a screen with its queries still pending).
  const state = useSyncExternalStore(subscribe, snapshot, snapshot) as QueryState<T>
  // biome-ignore lint/correctness/useExhaustiveDependencies: the loader is read when it runs; a new function each render must not load again
  useEffect(() => {
    if (!key) return
    const entry = entryFor(key, options.persist)
    const registration = registrationFor(key)
    registration.load = load
    registration.freshMs = options.freshMs ?? FRESH_MS
    registration.idle = Boolean(options.idle)
    if (!entry.inflight && !registration.idle && Date.now() - entry.loadedAt > registration.freshMs)
      void fetchQuery(key)
  }, [key, options.idle, options.freshMs])
  // "Try again": always a new request, even while an earlier one has not answered.
  const reload = useCallback(
    () => (key ? fetchQuery(key, undefined, { persist: options.persist }, true) : Promise.resolve()),
    [key, options.persist],
  )
  return { ...state, reload }
}
