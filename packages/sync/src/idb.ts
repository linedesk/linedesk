// Tiny IndexedDB wrapper. Stores: one per synced table (confirmed server rows), `outbox`
// (pending commands, in order) and `meta` (read-sync cursors).
import { tableNames } from '@linedesk/db/types'

const stores = [...tableNames, 'outbox', 'meta'] as const
export type StoreName = (typeof stores)[number]

const OPEN_TIMEOUT_MS = 8000
/** Upgrade attempts before giving up; another tab upgrading at the same moment costs one. */
const UPGRADE_ATTEMPTS = 3

const missingStores = (db: IDBDatabase) => stores.filter(s => !db.objectStoreNames.contains(s))

/**
 * Opens at whatever version the device has, then upgrades by one only if a store this build needs
 * is missing. There is no hand-kept version number: a new synced table gets its store on the next
 * open, and a database a newer build (or another branch) upgraded opens as it is when it has every
 * store. Opening waits behind a pending delete or upgrade from another tab; it fails rather than hangs.
 */
async function open(name: string, timeoutMs: number) {
  for (let attempt = 0; attempt < UPGRADE_ATTEMPTS; attempt++) {
    const db = await openAt(name, undefined, timeoutMs)
    if (missingStores(db).length === 0) return db
    const next = db.version + 1
    db.close()
    try {
      const upgraded = await openAt(name, next, timeoutMs)
      if (missingStores(upgraded).length === 0) return upgraded
      upgraded.close()
    } catch (e) {
      // another tab upgraded first: look again
      if (!(e instanceof DOMException && e.name === 'VersionError')) throw e
    }
  }
  throw new Error('The local database could not be set up.')
}

const openAt = (name: string, version: number | undefined, timeoutMs: number) => new Promise<IDBDatabase>((resolve, reject) => {
  const req = indexedDB.open(name, version)
  const timer = setTimeout(() => reject(new Error('The local database did not open. Another tab may be holding it.')), timeoutMs)
  // Upgrades only add the stores this build is missing; the ones a device has already stay as they are.
  req.onupgradeneeded = () => { for (const s of missingStores(req.result)) req.result.createObjectStore(s) }
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

/**
 * Empties the local copy of server data so the next open syncs it again. Unsent changes (`outbox`)
 * stay. A database that does not open at all is deleted, outbox included: nothing could read it anyway.
 */
export async function resetLocalCache(name: string, { timeoutMs = OPEN_TIMEOUT_MS }: Pick<Options, 'timeoutMs'> = {}) {
  let db: IDBDatabase
  try {
    db = await openAt(name, undefined, timeoutMs)
  } catch {
    return deleteDatabase(name)
  }
  try {
    const cached = [...db.objectStoreNames].filter(s => s !== 'outbox')
    if (cached.length > 0) {
      const tx = db.transaction(cached, 'readwrite')
      for (const s of cached) tx.objectStore(s).clear()
      await done(tx)
    }
  } finally {
    db.close()
  }
}

/** Resolves when the database is gone, or when the browser keeps it for a moment because another tab holds it. */
const deleteDatabase = (name: string) => new Promise<void>(resolve => {
  const req = indexedDB.deleteDatabase(name)
  req.onsuccess = req.onerror = req.onblocked = () => resolve()
})
