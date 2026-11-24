// The workspace this tab works in. It is fixed when the tab opens (the session's workspace at that
// moment) and sent with every workspace request, so a switch in another tab never makes this tab
// read or write another workspace: the server refuses the request instead (workspaceRefusal in the
// API), and this tab says which workspace it is on. Switching announces itself to the other tabs.
import { workspaceRequestHeaders } from '@linedesk/sync'

let current: string | null = null
let account: string | null = null

/** Set once the session is known: the workspace (null without one) and the account this page is for. */
export function setTabWorkspace(id: string | null, forAccount: string | null = null) {
  current = id
  account = forAccount
}

export const tabWorkspace = () => current

/** The headers that name this tab's workspace and account and this page's protocol, for requests to /v1 that act in it. */
export function workspaceHeaders(): Record<string, string> {
  return workspaceRequestHeaders({ workspaceId: current, account })
}

type SessionMessage = { type: 'switched'; workspaceId: string; from: string }
const CHANNEL = 'linedesk-session'
/**
 * This page's id: a BroadcastChannel also delivers to the other channels of the same page, so the page that switches
 * would otherwise see its own switch and say "you switched in another tab" until its reload.
 */
const PAGE = Math.random().toString(36).slice(2)

const channel = () => (typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(CHANNEL))

/** Tells the other tabs that the session now works in `workspaceId` (they show which one they are on). */
export function announceSwitch(workspaceId: string) {
  const c = channel()
  c?.postMessage({ type: 'switched', workspaceId, from: PAGE } satisfies SessionMessage)
  c?.close()
}

/** Calls `onSwitch` when another tab switched the session's workspace. Returns a stop function. */
export function onSwitchElsewhere(onSwitch: (workspaceId: string) => void): () => void {
  const c = channel()
  if (!c) return () => {}
  c.onmessage = e => {
    const m = e.data as SessionMessage
    if (m?.type === 'switched' && typeof m.workspaceId === 'string' && m.from !== PAGE) onSwitch(m.workspaceId)
  }
  return () => c.close()
}
