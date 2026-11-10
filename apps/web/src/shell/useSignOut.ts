import { useRef } from 'react'
import { auth } from '../auth.ts'
import { forgetMe } from '../session.ts'
import { stopAllStores } from '../storeCache.ts'
import { localDbName, useStore } from '../store.tsx'

const SETTLE_MS = 2000
const POLL_MS = 150

type Options = { workspaceId: string; onSignedOut: () => void | Promise<void>; toast: (text: string) => void }

/**
 * Sign out without losing work: unsent changes are sent first. If some cannot be sent (offline),
 * the first attempt only says so; signing out again discards them.
 */
export function useSignOut({ workspaceId, onSignedOut, toast }: Options) {
  const store = useStore()
  const warnedAbout = useRef(0)

  /** Give the outbox a moment to empty; returns how many changes are still unsent. */
  async function unsentAfterFlush(): Promise<number> {
    const deadline = Date.now() + SETTLE_MS
    while (store.getSnapshot().pending > 0 && store.getSnapshot().online && Date.now() < deadline) {
      await store.flush()
      await new Promise(resolve => setTimeout(resolve, POLL_MS))
    }
    return store.getSnapshot().pending
  }

  return async function signOut() {
    const unsent = await unsentAfterFlush()
    if (unsent > 0 && warnedAbout.current !== unsent) {
      warnedAbout.current = unsent
      return toast(`${unsent} ${unsent === 1 ? 'change has' : 'changes have'} not been sent yet. Reconnect to keep ${unsent === 1 ? 'it' : 'them'}, or sign out again to discard.`)
    }
    await auth.signOut()
    forgetMe()
    await onSignedOut()
    await stopAllStores() // the database is free to delete
    indexedDB.deleteDatabase(localDbName(workspaceId)) // local rows belong to the signed-in member
  }
}
