// One local store per workspace. Components read rows with useRows() and write with useRun().
import type { TableName, Tables } from '@linedesk/db/types'
import { resetLocalCache, type Rejection, type Store } from '@linedesk/sync'
import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import { forgetElectricState } from './localData.ts'
import { leaseStore } from './storeCache.ts'
import { BootScreen } from './ui/BootScreen.tsx'

type Ctx = { store: Store; rejection: Rejection | null; clearRejection: () => void }
const StoreContext = createContext<Ctx | null>(null)

export const localDbName = (workspaceId: string) => `linedesk-${workspaceId}`

type Boot = { state: 'loading' } | { state: 'failed' } | { state: 'ready'; store: Store }

/** Why nothing can be changed (a disabled workspace): writes are refused here, before anything changes on screen. */
export const DISABLED_WORKSPACE = 'This workspace is disabled, so nothing can be changed.'

/**
 * Opens the local store. While it opens a quiet loading line shows; if it cannot open, an error with Reload: never a blank page.
 * `account`: whose local data this is (the database is emptied when another account opens it).
 * `readOnly`: the reason writes are refused at once (no optimistic change that rolls back after the server's 403).
 */
export function StoreProvider({
  workspaceId,
  account,
  readOnly,
  children,
}: { workspaceId: string; account: string; readOnly?: string; children: ReactNode }) {
  const [boot, setBoot] = useState<Boot>({ state: 'loading' })
  const [rejection, setRejection] = useState<Rejection | null>(null)
  useEffect(() => {
    let live = true
    const lease = leaseStore(localDbName(workspaceId), workspaceId, account, setRejection)
    lease.ready.then(
      store => {
        if (live) setBoot({ state: 'ready', store })
      },
      (error: unknown) => {
        console.error('The local store did not open', error)
        if (live) setBoot({ state: 'failed' })
      },
    )
    return () => {
      live = false
      lease.release()
      setBoot({ state: 'loading' })
    }
  }, [workspaceId, account])
  const store = boot.state === 'ready' ? boot.store : null
  const value = useMemo(() => {
    if (!store) return null
    const refuse: Store['run'] = async (name, input) => setRejection({ action: name, input, error: readOnly! })
    return { store: readOnly ? { ...store, run: refuse } : store, rejection, clearRejection: () => setRejection(null) }
  }, [store, rejection, readOnly])
  if (value) return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>
  if (boot.state === 'failed') {
    return (
      <div className="boot" role="alert">
        <b>Your calls could not be loaded</b>
        <span>Reloading fetches them from the server again. Changes you have not sent yet are kept.</span>
        <button type="button" className="k-btn k-btn-primary k-btn-md" onClick={() => void reloadFromServer(workspaceId)}>
          Reload
        </button>
      </div>
    )
  }
  return <BootScreen line="Loading your calls…" />
}

/** Empties this workspace's local copy (unsent changes stay) and reloads, so everything syncs fresh. */
async function reloadFromServer(workspaceId: string) {
  try {
    forgetElectricState()
    await resetLocalCache(localDbName(workspaceId))
  } finally {
    window.location.reload()
  }
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

const noStore = () => () => {}
/** Whether read sync has not reached the server for a while; false outside a workspace (Admin without one). */
export function useReadSyncDown(): boolean {
  const store = useContext(StoreContext)?.store
  return useSyncExternalStore(store?.subscribe ?? noStore, () => store?.getSnapshot().readSyncDown ?? false)
}

/** Whether the workspace is disabled, as the server's latest answer said; null until one did. */
export function useWorkspaceState() {
  const { store } = useCtx()
  return useSyncExternalStore(store.subscribe, () => store.getSnapshot().workspaceState)
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

/** The workspace's assistants, oldest first: the first one is the default (it answers numbers that name none). */
export function useAssistants() {
  const rows = useRows('assistants')
  return useMemo(
    () => [...rows].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)),
    [rows],
  )
}
/** The workspace's default assistant. */
export function useAssistant() {
  return useAssistants()[0]
}
export const useAssistantName = () => useAssistant()?.name ?? 'Assistant'
/** The assistant that handled a call (calls from before several assistants: the default one). */
export function useCallAssistantName(assistantId: string | null): string {
  const assistants = useAssistants()
  return (assistants.find(a => a.id === assistantId) ?? assistants[0])?.name ?? 'Assistant'
}

// A hot update of this module would create a second context while the old provider stays mounted
// ("useStore outside StoreProvider"): reload the page instead.
import.meta.hot?.accept(() => window.location.reload())
