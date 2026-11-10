// Tiny IndexedDB wrapper. Stores: one per synced table (confirmed server rows), `outbox`
// (pending commands, in order) and `meta` (read-sync cursors).
import { tableNames } from '@callfront/db/types'

const stores = [...tableNames, 'outbox', 'meta'] as const
export type StoreName = (typeof stores)[number]

const OPEN_TIMEOUT_MS = 8000

/** Opening waits behind a pending delete or upgrade from another tab; it must fail rather than hang. */
const open = (name: string, timeoutMs: number) => new Promise<IDBDatabase>((resolve, reject) => {
  const req = indexedDB.open(name, 1)
  const timer = setTimeout(() => reject(new Error('The local database did not open. Another tab may be holding it.')), timeoutMs)
  req.onupgradeneeded = () => { for (const s of stores) req.result.createObjectStore(s) }
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
    all<T>(store: StoreName) {
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
