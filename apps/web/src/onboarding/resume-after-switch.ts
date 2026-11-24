// One click is enough on the agent setup page: "Set up forwarding" or "Call <assistant> now" for a workspace that is
// not this tab's active one first switches to it (the page reloads into it, staying on #setup-agent), then carries on
// with the same action. What to carry on with is kept in this tab's session storage across the reload, for that
// workspace only and for a minute at most, and used once.

export type ResumeAction = 'forwarding' | 'test_call'

type Saved = { workspaceId: string; action: ResumeAction; at: number }
type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem'>

const KEY = 'linedesk.agentSetup.resume'
/** Longer than any switch and reload; an older one is a leftover, not a click the admin is waiting on. */
export const RESUME_MAX_AGE_MS = 60_000

const session = (): Storage | null => {
  try {
    return globalThis.sessionStorage ?? null
  } catch {
    return null
  }
}

/** Before switching: carry on with `action` once the tab is in `workspaceId`. */
export function saveResume(workspaceId: string, action: ResumeAction, store = session(), now = Date.now()) {
  try {
    store?.setItem(KEY, JSON.stringify({ workspaceId, action, at: now } satisfies Saved))
  } catch {}
}

/** After the reload: the action to carry on with in the active workspace, if one was asked for it a moment ago. */
export function peekResume(activeId: string | null, store = session(), now = Date.now()): ResumeAction | null {
  if (!activeId) return null
  try {
    const raw = store?.getItem(KEY)
    if (!raw) return null
    const saved = JSON.parse(raw) as Partial<Saved>
    if (saved.workspaceId !== activeId) return null
    if (typeof saved.at !== 'number' || now - saved.at > RESUME_MAX_AGE_MS || saved.at > now) return null
    return saved.action === 'forwarding' || saved.action === 'test_call' ? saved.action : null
  } catch {
    return null
  }
}

/** Used (or the switch failed): never again. */
export function clearResume(store = session()) {
  try {
    store?.removeItem(KEY)
  } catch {}
}
