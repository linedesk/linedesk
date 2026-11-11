// The server refuses to read or write the workspace a tab works in (the API's workspaceRefusal):
// the session switched to another workspace in another tab, or the member lost access. From then
// on the tab sends and reads nothing until it reloads; pending writes stay in the outbox.

export const WORKSPACE_HEADER = 'x-workspace-id'

export type WorkspaceRefusal = {
  code: 'workspace_switched' | 'workspace_access_lost'
  /** With `workspace_switched`: the workspace the session is on now. */
  activeWorkspaceId?: string
}

const codes: readonly string[] = ['workspace_switched', 'workspace_access_lost'] satisfies WorkspaceRefusal['code'][]

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
