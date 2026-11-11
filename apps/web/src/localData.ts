// What this browser keeps of the signed-in person: one IndexedDB database per workspace
// (`linedesk-<id>`, rows and unsent changes), Electric's bookkeeping in localStorage (`electric_*`),
// cached reads (cachedQuery.ts) and the last /v1/me (session.ts). It belongs to that session only,
// so every way out (sign-out, another account, removal, an impersonation that starts or ends)
// deletes all of it, not only the workspace that happens to be open.
import { auth } from './auth.ts'
import { forgetMe, type Session } from './session.ts'
import { stopAllStores } from './storeCache.ts'

const DB_PREFIX = 'linedesk-'
const ELECTRIC_PREFIX = 'electric_'

/** The names of this origin's workspace databases; `known` covers browsers without indexedDB.databases(). */
export async function localDatabaseNames(known: readonly string[] = []): Promise<string[]> {
  let listed: string[] = []
  try {
    listed = (await indexedDB.databases()).map(d => d.name ?? '')
  } catch {
    /* not supported: the ones this page opened are still deleted */
  }
  return [...new Set([...listed, ...known])].filter(name => name.startsWith(DB_PREFIX))
}

/** Electric's keys in localStorage: shape handles and up-to-date markers of the session's shapes. */
export function forgetElectricState(storage: Pick<Storage, 'length' | 'key' | 'removeItem'> = localStorage) {
  try {
    const keys: string[] = []
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i)
      if (key?.startsWith(ELECTRIC_PREFIX)) keys.push(key)
    }
    for (const key of keys) storage.removeItem(key)
  } catch {
    /* private window: nothing was stored */
  }
}

/**
 * Deletes everything this browser keeps for the session that is ending. Open stores stop first, so
 * their databases can go; other tabs holding one close it and reload (idb.ts onLost).
 */
export async function forgetLocalData() {
  const open = await stopAllStores()
  forgetMe()
  forgetElectricState()
  await Promise.all((await localDatabaseNames(open)).map(deleteDatabase))
}

/** Ends the session and deletes what this browser kept of it ("Use a different account" and the like). */
export async function signOutAndForget() {
  await auth.signOut()
  await forgetLocalData()
}

/** Ends this session and shows the sign-in screen; signing in comes back to the same page. */
export async function signInAgain() {
  await signOutAndForget()
  window.location.reload()
}

/**
 * Once the session is known: what this browser keeps beyond it goes. Signed out or without a
 * workspace: everything. Signed in: the databases of workspaces the member does not belong to
 * (removed from one, or someone else used this browser before). Offline nothing is known, so nothing goes.
 */
export async function forgetBeyond(session: Session) {
  if (session.state === 'signedOut' || session.state === 'needsWorkspace') return forgetLocalData()
  if (session.state !== 'ready' || session.offline) return
  const { me } = session
  await forgetOtherWorkspaces(me.workspaces?.map(w => w.id) ?? (me.workspace ? [me.workspace.id] : []))
}

/** Deletes the local databases of every workspace but `keep`. */
export async function forgetOtherWorkspaces(keep: readonly string[]) {
  const wanted = new Set(keep.map(id => `${DB_PREFIX}${id}`))
  const stale = (await localDatabaseNames()).filter(name => !wanted.has(name))
  await Promise.all(stale.map(deleteDatabase))
}

/** Resolves when the database is gone, or when the browser keeps it for a moment because another tab holds it. */
const deleteDatabase = (name: string) =>
  new Promise<void>(resolve => {
    const req = indexedDB.deleteDatabase(name)
    req.onsuccess = req.onerror = req.onblocked = () => resolve()
  })
