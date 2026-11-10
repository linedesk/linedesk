// One local store per workspace. Components read rows with useRows() and write with useRun().
import type { TableName, Tables } from '@callfront/db/types'
import { createStore, electricAdapter, type Rejection, type Store } from '@callfront/sync'
import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'

type Ctx = { store: Store; rejection: Rejection | null; clearRejection: () => void }
const StoreContext = createContext<Ctx | null>(null)

export const localDbName = (workspaceId: string) => `callfront-${workspaceId}`

export function StoreProvider({ workspaceId, children }: { workspaceId: string; children: ReactNode }) {
  const [store, setStore] = useState<Store | null>(null)
  const [rejection, setRejection] = useState<Rejection | null>(null)
  useEffect(() => {
    let live = true
    let created: Store | undefined
    void createStore({ api: '', dbName: localDbName(workspaceId), adapter: electricAdapter(window.location.origin), onReject: setRejection })
      .then(s => { created = s; if (live) setStore(s); else s.stop() })
    return () => { live = false; created?.stop(); setStore(null) }
  }, [workspaceId])
  const value = useMemo(() => store && { store, rejection, clearRejection: () => setRejection(null) }, [store, rejection])
  return value ? <StoreContext.Provider value={value}>{children}</StoreContext.Provider> : null
}

function useCtx() {
  const ctx = useContext(StoreContext)
  if (!ctx) throw new Error('useStore outside StoreProvider')
  return ctx
}

export function useSnapshot() {
  const { store } = useCtx()
  return useSyncExternalStore(store.subscribe, store.getSnapshot)
}

export function useRows<T extends TableName>(table: T): Tables[T][] {
  const map = useSnapshot().tables[table]
  return useMemo(() => [...map.values()], [map])
}

/** Run a registry action: applied locally at once, synced in the background. */
export function useRun() {
  const { store } = useCtx()
  return store.run
}

export function useRejection() {
  const { rejection, clearRejection } = useCtx()
  return { rejection, clearRejection }
}

export function useContact(id: string | null) {
  const contacts = useSnapshot().tables.contacts
  return id ? contacts.get(id) : undefined
}

/** The workspace's assistant (one per workspace). */
export function useAssistant() {
  return useRows('assistants')[0]
}
export const useAssistantName = () => useAssistant()?.name ?? 'Assistant'
