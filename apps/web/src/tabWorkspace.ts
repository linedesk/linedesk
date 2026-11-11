// The workspace this tab works in. It is fixed when the tab opens (the session's workspace at that
// moment) and sent with every workspace request, so a switch in another tab never makes this tab
// read or write another workspace: the server refuses the request instead (workspaceRefusal in the
// API), and this tab says which workspace it is on. Switching announces itself to the other tabs.
import { WORKSPACE_HEADER } from '@linedesk/sync'

let current: string | null = null

/** Set once the session is known; null while signed out or without a workspace. */
export function setTabWorkspace(id: string | null) {
  current = id
}

export const tabWorkspace = () => current

/** The header that names this tab's workspace, for requests to /v1 that act in it. */
export function workspaceHeaders(): Record<string, string> {
  return current ? { [WORKSPACE_HEADER]: current } : {}
}

type SessionMessage = { type: 'switched'; workspaceId: string }
const CHANNEL = 'linedesk-session'

const channel = () => (typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(CHANNEL))

/** Tells the other tabs that the session now works in `workspaceId` (they show which one they are on). */
export function announceSwitch(workspaceId: string) {
  const c = channel()
  c?.postMessage({ type: 'switched', workspaceId } satisfies SessionMessage)
  c?.close()
}

/** Calls `onSwitch` when another tab switched the session's workspace. Returns a stop function. */
export function onSwitchElsewhere(onSwitch: (workspaceId: string) => void): () => void {
  const c = channel()
  if (!c) return () => {}
  c.onmessage = e => {
    const m = e.data as SessionMessage
    if (m?.type === 'switched' && typeof m.workspaceId === 'string') onSwitch(m.workspaceId)
  }
  return () => c.close()
}
