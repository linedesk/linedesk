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
type Options = { persist?: boolean }

type Entry = {
  state: QueryState<unknown>
  load?: () => Promise<unknown>
  persist: boolean
  loadedAt: number
  /** How often the page put an answer in place itself (setQueryData). */
  changes: number
  inflight?: Promise<void>
  listeners: Set<() => void>
}

const STORAGE_PREFIX = 'linedesk-q:'
/** A query that was loaded this recently is not loaded again when another component mounts. */
const FRESH_MS = 5_000
const EMPTY: QueryState<never> = { data: undefined, error: null }

const entries = new Map<string, Entry>()
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
      listeners: new Set(),
    }
    entries.set(key, entry)
  }
  if (persist && !entry.persist) entry.persist = true
  return entry
}

function publish(key: string, entry: Entry, state: QueryState<unknown>) {
  entry.state = state
  if (entry.persist && state.data !== undefined) writeStored(key, state.data)
  for (const listener of entry.listeners) listener()
}

/**
 * The member and workspace the cached answers belong to. Changing it starts with an empty memory;
 * persisted answers of the new scope are read when they are first used.
 */
export function setQueryScope(next: string) {
  if (next === scope) return
  scope = next
  entries.clear()
}

/** Loads the query now (once at a time) and shares the answer. A failure keeps the last answer. */
export function fetchQuery<T>(key: string, load?: () => Promise<T>, options: Options = {}): Promise<void> {
  const entry = entryFor(key, options.persist)
  if (load) entry.load = load
  if (entry.inflight) return entry.inflight
  const run = entry.load
  if (!run) return Promise.resolve()
  const changesBefore = entry.changes
  const inflight = run().then(
    // An answer the server gave before a change the page made since would undo that change on screen.
    data => (entry.changes !== changesBefore ? undefined : publish(key, entry, { data, error: null })),
    (err: unknown) =>
      publish(key, entry, { data: entry.state.data, error: err instanceof Error ? err.message : String(err) }),
  )
  entry.inflight = inflight.finally(() => {
    entry.inflight = undefined
    entry.loadedAt = Date.now()
  })
  return entry.inflight
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

/**
 * On sign-out: drops every answer of every member on this device, in memory and in localStorage.
 * Answers without a member (what the sign-in page shows) stay.
 */
export function forgetQueries() {
  entries.clear()
  scope = ''
  const signedOut = storageKey('')
  try {
    for (const key of Object.keys(localStorage))
      if (key.startsWith(STORAGE_PREFIX) && !key.startsWith(signedOut)) localStorage.removeItem(key)
  } catch {
    /* nothing was stored */
  }
}

/** Another account signed in on this browser: the answers stored for every other member go; this member's stay. */
export function forgetOtherMembersQueries(actorId: string) {
  const signedOut = `${STORAGE_PREFIX}:` // what the sign-in page shows
  const own = `${STORAGE_PREFIX}${actorId}/`
  try {
    for (const key of Object.keys(localStorage))
      if (key.startsWith(STORAGE_PREFIX) && !key.startsWith(signedOut) && !key.startsWith(own)) localStorage.removeItem(key)
  } catch {
    /* nothing was stored */
  }
}

/** Queries someone is looking at are checked again when the window gets focus back (not right after a load). */
function refreshShown() {
  const now = Date.now()
  for (const [key, entry] of entries)
    if (entry.listeners.size > 0 && now - entry.loadedAt > FRESH_MS) void fetchQuery(key)
}
if (typeof window !== 'undefined') {
  window.addEventListener('focus', refreshShown)
  // A tab shown again (switching tabs does not always move the window's focus).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshShown()
  })
}

/**
 * A query's last answer, at once, and a fresh one in the background. `key` names what is loaded
 * (one key, one loader); null loads nothing.
 */
export function useQuery<T>(key: string | null, load: () => Promise<T>, options: Options = {}): Query<T> {
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!key) return () => {}
      const entry = entryFor(key, options.persist)
      entry.listeners.add(listener)
      return () => entry.listeners.delete(listener)
    },
    [key, options.persist],
  )
  const state = useSyncExternalStore(subscribe, () =>
    key ? entryFor(key, options.persist).state : EMPTY,
  ) as QueryState<T>
  // biome-ignore lint/correctness/useExhaustiveDependencies: the loader is read when it runs; a new function each render must not load again
  useEffect(() => {
    if (!key) return
    const entry = entryFor(key, options.persist)
    entry.load = load
    if (!entry.inflight && Date.now() - entry.loadedAt > FRESH_MS) void fetchQuery(key)
  }, [key])
  const reload = useCallback(() => (key ? fetchQuery(key) : Promise.resolve()), [key])
  return { ...state, reload }
}
