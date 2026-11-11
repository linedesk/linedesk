// One local store per workspace. Components read rows with useRows() and write with useRun().
import type { TableName, Tables } from '@linedesk/db/types'
import type { Rejection, Store } from '@linedesk/sync'
import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import { leaseStore } from './storeCache.ts'
import { BootScreen } from './ui/BootScreen.tsx'

type Ctx = { store: Store; rejection: Rejection | null; clearRejection: () => void }
const StoreContext = createContext<Ctx | null>(null)

export const localDbName = (workspaceId: string) => `linedesk-${workspaceId}`

type Boot = { state: 'loading' } | { state: 'failed'; error: string } | { state: 'ready'; store: Store }

/** Opens the local store. While it opens a quiet loading line shows; if it cannot open, an error with Reload: never a blank page. */
export function StoreProvider({ workspaceId, children }: { workspaceId: string; children: ReactNode }) {
  const [boot, setBoot] = useState<Boot>({ state: 'loading' })
  const [rejection, setRejection] = useState<Rejection | null>(null)
  useEffect(() => {
    let live = true
    const lease = leaseStore(localDbName(workspaceId), setRejection)
    lease.ready.then(
      store => {
        if (live) setBoot({ state: 'ready', store })
      },
      (error: unknown) => {
        if (live) setBoot({ state: 'failed', error: error instanceof Error ? error.message : String(error) })
      },
    )
    return () => {
      live = false
      lease.release()
      setBoot({ state: 'loading' })
    }
  }, [workspaceId])
  const store = boot.state === 'ready' ? boot.store : null
  const value = useMemo(
    () => store && { store, rejection, clearRejection: () => setRejection(null) },
    [store, rejection],
  )
  if (value) return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>
  if (boot.state === 'failed') {
    return (
      <div className="boot" role="alert">
        <b>Your calls could not be loaded</b>
        <span>{boot.error}</span>
        <button type="button" className="k-btn k-btn-primary k-btn-md" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    )
  }
  return <BootScreen line="Loading your calls…" />
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

/** The store itself, for the few places that need to flush or look at the outbox directly. */
export function useStore() {
  return useCtx().store
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

// A hot update of this module would create a second context while the old provider stays mounted
// ("useStore outside StoreProvider"): reload the page instead.
import.meta.hot?.accept(() => window.location.reload())
