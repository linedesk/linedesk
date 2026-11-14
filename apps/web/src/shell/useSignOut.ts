import { useRef } from 'react'
import { auth } from '../auth.ts'
import { forgetLocalData } from '../localData.ts'
import { stopPushOnSignOut } from '../push.ts'
import { useStore } from '../store.tsx'
import { clearRoute } from './useRoute.ts'

const SETTLE_MS = 2000
const POLL_MS = 150

type Options = { onSignedOut: () => void | Promise<void>; toast: (text: string) => void }

/**
 * Sign out without losing work: unsent changes are sent first. If some cannot be sent (offline),
 * the first attempt only says so; signing out again discards them.
 */
export function useSignOut({ onSignedOut, toast }: Options) {
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
    // Pushes stop for this browser before the session ends (the server needs it to know whose they are).
    await stopPushOnSignOut()
    await auth.signOut()
    // Every workspace's local rows, Electric's state and cached reads belong to the member who leaves.
    await forgetLocalData()
    // The page this member was on is theirs too: whoever signs in next starts in the inbox.
    clearRoute()
    await onSignedOut()
  }
}
