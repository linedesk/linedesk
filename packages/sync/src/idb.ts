// Tiny IndexedDB wrapper. Stores: one per synced table (confirmed server rows), `outbox`
// (pending commands, in order) and `meta` (read-sync cursors).
import { tableNames } from '@callfront/db/types'

const stores = [...tableNames, 'outbox', 'meta'] as const
export type StoreName = (typeof stores)[number]

const open = (name: string) => new Promise<IDBDatabase>((resolve, reject) => {
  const req = indexedDB.open(name, 1)
  req.onupgradeneeded = () => { for (const s of stores) req.result.createObjectStore(s) }
  req.onsuccess = () => resolve(req.result)
  req.onerror = () => reject(req.error)
})

const done = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => {
  tx.oncomplete = () => resolve()
  tx.onerror = () => reject(tx.error)
  tx.onabort = () => reject(tx.error)
})

export async function openLocalDb(name: string) {
  const db = await open(name)
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
    write(store: StoreName, fn: (s: IDBObjectStore) => void) {
      const tx = db.transaction(store, 'readwrite')
      fn(tx.objectStore(store))
      return done(tx)
    },
    close: () => db.close(),
  }
}
export type LocalDb = Awaited<ReturnType<typeof openLocalDb>>
