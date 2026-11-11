// One store per workspace database in this page. React's StrictMode (and a remount) start and
// stop a provider twice in a row; without this the page held two stores on one database for a
// moment and both sent the same command.
import { createStore, electricAdapter, type Rejection, type Store } from '@linedesk/sync'
import { takeRefreshOnReturn } from './refreshOnReturn.ts'

/** Tables followed live: what changes while calls come in. Four long-polls leave room for writes over HTTP/1.1. */
const LIVE_TABLES = ['calls', 'transcript_segments', 'contacts', 'bookings'] as const

type Entry = {
  ready: Promise<Store>
  users: number
  stopTimer?: ReturnType<typeof setTimeout>
  onReject: Set<(r: Rejection) => void>
}
const open = new Map<string, Entry>()

export type StoreLease = { ready: Promise<Store>; release: () => void }

/** A store for this workspace's database, shared by everyone who holds a lease. It stops a moment after the last lease is released. */
export function leaseStore(dbName: string, workspaceId: string, account: string, onReject: (r: Rejection) => void): StoreLease {
  let entry = open.get(dbName)
  if (!entry) {
    const listeners = new Set<(r: Rejection) => void>()
    const created: Entry = {
      users: 0,
      onReject: listeners,
      ready: createStore({
        api: '',
        dbName,
        workspaceId,
        account,
        // Live only what changes during calls; settings-like tables are checked on focus, after a write and every minute.
        adapter: electricAdapter(window.location.origin, { liveTables: LIVE_TABLES, workspaceId, account }),
        appVersion: import.meta.env.VITE_APP_BUILD,
        onReject: r => listeners.forEach(l => l(r)),
        onLocalDbLost: () => window.location.reload(), // another tab signed out and removed the local data
        refreshOnStart: takeRefreshOnReturn(), // back from a redirect that changed these on the server
      }),
    }
    created.ready.catch(() => open.delete(dbName)) // a later lease tries again
    open.set(dbName, created)
    entry = created
  }
  const mine = entry
  clearTimeout(mine.stopTimer)
  mine.users++
  mine.onReject.add(onReject)
  let released = false
  return {
    ready: mine.ready,
    release() {
      if (released) return
      released = true
      mine.onReject.delete(onReject)
      if (--mine.users > 0) return
      mine.stopTimer = setTimeout(() => {
        if (mine.users > 0) return
        open.delete(dbName)
        void mine.ready.then(
          store => store.stop(),
          () => {},
        )
      }, 0)
    },
  }
}

/**
 * Sends what every open store still has waiting, for up to `ms`; returns how many changes are still
 * unsent. Before the browser changes to another user's session (impersonation), so that no change
 * goes out under the wrong session.
 */
export async function flushAllStores(ms = 2000, pollMs = 150): Promise<number> {
  const stores = await Promise.all([...open.values()].map(e => e.ready.catch(() => null)))
  const pending = () => stores.reduce((sum, s) => sum + (s?.getSnapshot().pending ?? 0), 0)
  const deadline = Date.now() + ms
  while (pending() > 0 && stores.every(s => !s || s.getSnapshot().online) && Date.now() < deadline) {
    await Promise.all(stores.map(s => s?.flush()))
    await new Promise(resolve => setTimeout(resolve, pollMs))
  }
  return pending()
}

/** Stop every store now, so their databases can be deleted (localData.ts); returns the databases' names. */
export async function stopAllStores(): Promise<string[]> {
  const names = [...open.keys()]
  const entries = [...open.values()]
  open.clear()
  for (const e of entries) {
    clearTimeout(e.stopTimer)
    try {
      ;(await e.ready).stop()
    } catch {
      /* never opened */
    }
  }
  return names
}
