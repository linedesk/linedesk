// Team actions run online against the API: members and invitations are not in the local store,
// and a role change or removal must not look done before the server has accepted it.
import type { AssignableRole, InvitationPreview, TeamRole, TeamData, TeamLeaveData } from '@linedesk/actions'
import { fetchQuery, useQuery } from '../cachedQuery.ts'
import { workspaceHeaders } from '../tabWorkspace.ts'

const TEAM = 'team'

async function runTeamAction<T = unknown>(name: string, input: object): Promise<T> {
  const res = await fetch(`/v1/actions/${name}`, {
    method: 'POST',
    credentials: 'include',
    headers: { ...workspaceHeaders(), 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
    body: JSON.stringify(input),
  })
  const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: string; data?: T } | null
  if (!res.ok || !body?.ok) throw new Error(body?.error ?? 'That did not work. Try again.')
  return body.data as T
}

export const teamApi = {
  list: () => runTeamAction<TeamData>('team.list', {}),
  invite: (email: string, role: AssignableRole) => runTeamAction('team.invite', { email, role }),
  resend: (invitationId: string) => runTeamAction('team.resendInvite', { invitationId }),
  revoke: (invitationId: string) => runTeamAction('team.revokeInvite', { invitationId }),
  setRole: (memberId: string, role: TeamRole) => runTeamAction('team.setRole', { memberId, role }),
  remove: (memberId: string) => runTeamAction('team.removeMember', { memberId }),
  leave: () => runTeamAction<TeamLeaveData>('team.leave', {}),
}

/** Members and invitations: the last known at once (also across page loads), refreshed in the background. Shared by the Team page and call assignment. */
export const useTeam = () => useQuery(TEAM, teamApi.list, { persist: true })
/** Loads the team ahead, at app start: the Team page and call assignment then open with it. */
export const preloadTeam = () => fetchQuery(TEAM, teamApi.list, { persist: true })

export async function previewInvitation(id: string): Promise<InvitationPreview> {
  const res = await fetch(`/v1/invitations/${encodeURIComponent(id)}`)
  if (!res.ok) throw new Error('Could not load the invitation')
  return (await res.json()) as InvitationPreview
}
