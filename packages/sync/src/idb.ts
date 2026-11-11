// Tiny IndexedDB wrapper. Stores: one per synced table (confirmed server rows), `outbox`
// (pending commands, in order) and `meta` (read-sync cursors).
import { tableNames } from '@linedesk/db/types'

const stores = [...tableNames, 'outbox', 'meta'] as const
export type StoreName = (typeof stores)[number]

const OPEN_TIMEOUT_MS = 8000
/** Bumped whenever a store is added. 2: appointment types, bookings, calendar accounts and the assistant's calendars. 3: webhook endpoints. */
const DB_VERSION = 3

/**
 * Opening waits behind a pending delete or upgrade from another tab; it must fail rather than hang.
 * A database a newer build already upgraded (an older build after a rollback, or a tab still on the
 * old build) is opened at its own version: versions only add stores, so it has every store this build needs.
 */
const open = (name: string, timeoutMs: number) => openAt(name, DB_VERSION, timeoutMs).catch((e: unknown) => {
  if (e instanceof DOMException && e.name === 'VersionError') return openAt(name, undefined, timeoutMs)
  throw e
})

const openAt = (name: string, version: number | undefined, timeoutMs: number) => new Promise<IDBDatabase>((resolve, reject) => {
  const req = indexedDB.open(name, version)
  const timer = setTimeout(() => reject(new Error('The local database did not open. Another tab may be holding it.')), timeoutMs)
  // Each version only adds stores (a new synced table); the ones a device has already stay as they are.
  req.onupgradeneeded = () => { for (const s of stores) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s) }
  req.onsuccess = () => { clearTimeout(timer); resolve(req.result) }
  req.onerror = () => { clearTimeout(timer); reject(req.error) }
  req.onblocked = () => { clearTimeout(timer); reject(new Error('The local database is in use by another tab.')) }
})

const done = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => {
  tx.oncomplete = () => resolve()
  tx.onerror = () => reject(tx.error)
  tx.onabort = () => reject(tx.error)
})

type Options = {
  /** Another tab wants to delete or upgrade the database (it signed out): this connection has closed to let it. */
  onLost?: () => void
  timeoutMs?: number
}

export async function openLocalDb(name: string, { onLost, timeoutMs = OPEN_TIMEOUT_MS }: Options = {}) {
  const db = await open(name, timeoutMs)
  let closed = false
  db.onversionchange = () => { closed = true; db.close(); onLost?.() } // never block another tab's delete
  return {
    /** After close() a read finds nothing (a tab that was handed the lead while it closes). */
    all<T>(store: StoreName) {
      if (closed) return Promise.resolve<[IDBValidKey, T][]>([])
      return new Promise<[IDBValidKey, T][]>((resolve, reject) => {
        const out: [IDBValidKey, T][] = []
        const cursor = db.transaction(store).objectStore(store).openCursor()
        cursor.onerror = () => reject(cursor.error)
        cursor.onsuccess = () => {
          const cur = cursor.result
          if (!cur) return resolve(out)
          out.push([cur.key, cur.value as T])
          cur.continue()
        }
      })
    },
    /** After close() a write is dropped: the store has stopped and nothing reads this database any more. */
    write(store: StoreName, fn: (s: IDBObjectStore) => void) {
      if (closed) return Promise.resolve()
      const tx = db.transaction(store, 'readwrite')
      fn(tx.objectStore(store))
      return done(tx)
    },
    close: () => { closed = true; db.close() },
  }
}
export type LocalDb = Awaited<ReturnType<typeof openLocalDb>>
