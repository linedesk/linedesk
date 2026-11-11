// The server refuses to read or write the workspace a tab works in (the API's guard): the session
// switched to another workspace in another tab, the member lost access, someone else signed in on
// this browser, or the page is older than the server. From then on the tab sends and reads nothing
// until it reloads; pending writes stay in the outbox.

import { CLIENT_PROTOCOL, CLIENT_PROTOCOL_HEADER } from '@linedesk/actions'

export const WORKSPACE_HEADER = 'x-workspace-id'
/** The account the page was opened for: the server refuses it once another account holds the cookie. */
export const ACCOUNT_HEADER = 'x-linedesk-account'

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
  code: 'workspace_switched' | 'workspace_access_lost' | 'client_outdated' | 'account_switched'
  /** With `workspace_switched`: the workspace the session is on now. */
  activeWorkspaceId?: string
}

const codes: readonly string[] = [
  'workspace_switched',
  'workspace_access_lost',
  'client_outdated',
  'account_switched',
] satisfies WorkspaceRefusal['code'][]

/** The refusal in a response body, or null for any other answer. */
export function asRefusal(body: unknown): WorkspaceRefusal | null {
  if (!body || typeof body !== 'object') return null
  const { code, activeWorkspaceId } = body as { code?: unknown; activeWorkspaceId?: unknown }
  if (typeof code !== 'string' || !codes.includes(code)) return null
  return {
    code: code as WorkspaceRefusal['code'],
    ...(typeof activeWorkspaceId === 'string' ? { activeWorkspaceId } : {}),
  }
}
