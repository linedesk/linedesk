// The server refuses to read or write the workspace a tab works in: the session switched to another
// workspace in another tab, the member lost access to it, the session is gone (signed out, expired,
// the account disabled), someone else signed in on this browser, or the page is older than the server.
// From then on the tab sends and reads nothing until it reloads. Pending writes stay in the outbox
// where they can still be sent by the same person later (a switch back, a reload into the new
// version, the first account signing in again); after a sign-out or lost access they never can and
// are rolled back.

import { CLIENT_PROTOCOL, CLIENT_PROTOCOL_HEADER } from '@linedesk/actions'

export const WORKSPACE_HEADER = 'x-workspace-id'
/** The account the page was opened for: the server refuses it once another account holds the cookie. */
export const ACCOUNT_HEADER = 'x-linedesk-account'

/** On every answer for a workspace: whether an instance admin has disabled it (read-only for members). */
export const WORKSPACE_STATE_HEADER = 'x-workspace-state'
export type WorkspaceState = 'active' | 'disabled'

/** Who and where a page works: its workspace and account, when known. */
export type PageScope = { workspaceId?: string | null; account?: string | null }

/** What every request that reads or writes this tab's workspace carries: workspace, account and this page's protocol (see CLIENT_PROTOCOL). */
export function workspaceRequestHeaders({ workspaceId, account }: PageScope = {}): Record<string, string> {
  return {
    [CLIENT_PROTOCOL_HEADER]: String(CLIENT_PROTOCOL),
    ...(workspaceId ? { [WORKSPACE_HEADER]: workspaceId } : {}),
    ...(account ? { [ACCOUNT_HEADER]: account } : {}),
  }
}

export type WorkspaceRefusal = {
  code: 'workspace_switched' | 'workspace_access_lost' | 'client_outdated' | 'account_switched' | 'signed_out'
  /** With `workspace_switched`: the workspace the session is on now. */
  activeWorkspaceId?: string
}

/** The codes the API's guard answers 403 with. */
const forbiddenCodes: readonly string[] = [
  'workspace_switched',
  'workspace_access_lost',
  'client_outdated',
  'account_switched',
] satisfies WorkspaceRefusal['code'][]

/** The codes the API's guard answers 401 with: no usable session (`no_workspace`: signed in, member of none). */
const unauthorizedCodes: readonly string[] = ['signed_out', 'no_workspace']

/** The 403 refusal in a response body, or null for any other answer. */
export function asRefusal(body: unknown): WorkspaceRefusal | null {
  if (!body || typeof body !== 'object') return null
  const { code, activeWorkspaceId } = body as { code?: unknown; activeWorkspaceId?: unknown }
  if (typeof code !== 'string' || !forbiddenCodes.includes(code)) return null
  return {
    code: code as WorkspaceRefusal['code'],
    ...(typeof activeWorkspaceId === 'string' ? { activeWorkspaceId } : {}),
  }
}

const codeOf = (body: unknown) => (body && typeof body === 'object' ? (body as { code?: unknown }).code : undefined)

/**
 * The refusal an answer stands for, or null for anything else. Only the API's own answers count: a 401
 * with its code (a proxy or another service in front could answer 401 for its own reasons, which must
 * not roll anybody's changes back), or a 403 that names a refusal.
 */
export function refusalOf(status: number, body: unknown): WorkspaceRefusal | null {
  if (status === 401) return unauthorizedCodes.includes(String(codeOf(body))) ? { code: 'signed_out' } : null
  return status === 403 ? asRefusal(body) : null
}

/**
 * Pending writes are kept where the same person can still send them: after a switch (switching back),
 * an update (the reload) or another account signing in (the first one signing in again; a database
 * opened for another account is emptied before anything is sent). Signed out or no access: rolled back.
 */
export const keepsPendingWrites = (refusal: WorkspaceRefusal) =>
  refusal.code === 'workspace_switched' || refusal.code === 'client_outdated' || refusal.code === 'account_switched'

/** The workspace state an answer reports, or null when it says none. */
export function workspaceStateOf(headers: { get(name: string): string | null }): WorkspaceState | null {
  const state = headers.get(WORKSPACE_STATE_HEADER)
  return state === 'active' || state === 'disabled' ? state : null
}
