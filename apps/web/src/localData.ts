// What this browser keeps of the signed-in person: one IndexedDB database per workspace
// (`linedesk-<id>`, rows and unsent changes), Electric's bookkeeping in localStorage (`electric_*`),
// cached reads (cachedQuery.ts) and the last /v1/me (session.ts). It belongs to that session only,
// so every way out (sign-out, another account, removal, an impersonation that starts or ends)
// deletes all of it, not only the workspace that happens to be open.
import { auth } from './auth.ts'
import { setReportedMember } from './errorReporting.ts'
import { forgetOtherMembersQueries } from './cachedQuery.ts'
import { endBrowserPush, stopPushOnSignOut } from './push.ts'
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
  forgetKeys([ACCOUNT_KEY, SEEN_INVITATIONS_KEY])
  await Promise.all((await localDatabaseNames(open)).map(deleteDatabase))
  // Pushes belong to the session too; the service worker itself keeps only the app shell.
  await endBrowserPush()
}

/** The account this browser's local data belongs to (set when a session opens, see forgetBeyond). */
const ACCOUNT_KEY = 'linedesk-account'
/** Invitations this browser already announced (shell/invitations.ts): they name the person's workspaces. */
const SEEN_INVITATIONS_KEY = 'linedesk.seenInvitations'
/**
 * The setup link this browser made (onboarding/AgentSetup.tsx), kept until it ends. Not part of forgetLocalData: an
 * admin without a workspace passes through that on every load. Signing out ends it here.
 */
export const SETUP_LINK_KEY = 'linedesk.setup.link'

function forgetKeys(keys: string[]) {
  try {
    for (const key of keys) localStorage.removeItem(key)
  } catch {
    /* private window: nothing was stored */
  }
}

/** Remembers whose local data this is; returns the account it belonged to before (null: nobody known). */
function claimLocalData(account: string): string | null {
  try {
    const before = localStorage.getItem(ACCOUNT_KEY)
    localStorage.setItem(ACCOUNT_KEY, account)
    return before
  } catch {
    return null
  }
}

/** Ends the session and deletes what this browser kept of it ("Use a different account" and the like). */
export async function signOutAndForget() {
  await stopPushOnSignOut()
  await auth.signOut()
  setReportedMember(null)
  await forgetLocalData()
  forgetKeys([SETUP_LINK_KEY])
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
  const before = claimLocalData(me.actorId)
  if (before && before !== me.actorId) {
    // Someone else signed in without signing the last person out (another tab): nothing of theirs
    // stays. The workspace opening now is emptied by its store (claimForAccount), the rest goes here.
    forgetElectricState()
    forgetOtherMembersQueries(me.actorId)
    forgetKeys([SEEN_INVITATIONS_KEY])
    return forgetOtherWorkspaces(me.workspace ? [me.workspace.id] : [])
  }
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
