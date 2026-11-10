import { organizationClient } from 'better-auth/client/plugins'
import { createAuthClient } from 'better-auth/react'

export const auth = createAuthClient({ baseURL: window.location.origin, plugins: [organizationClient()] })

export type Me = { actorId: string; role: string; permissions: string[]; workspace: { id: string; name: string } | null }

/** Who am I and which workspace am I in? null when signed out or without a workspace. */
export async function fetchMe(): Promise<Me | null> {
  const res = await fetch('/v1/me', { credentials: 'include' })
  return res.ok ? ((await res.json()) as Me) : null
}

export async function createWorkspace(name: string) {
  const res = await fetch('/v1/workspaces', {
    method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }),
  })
  if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error ?? 'Could not create the workspace')
}
