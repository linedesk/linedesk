// Team actions run online against the API: members and invitations are not in the local store,
// and a role change or removal must not look done before the server has accepted it.
import type { AssignableRole, InvitationPreview, TeamData } from '@linedesk/actions'

async function runTeamAction<T = unknown>(name: string, input: object): Promise<T> {
  const res = await fetch(`/v1/actions/${name}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
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
  setRole: (memberId: string, role: AssignableRole) => runTeamAction('team.setRole', { memberId, role }),
  remove: (memberId: string) => runTeamAction('team.removeMember', { memberId }),
}

export async function previewInvitation(id: string): Promise<InvitationPreview> {
  const res = await fetch(`/v1/invitations/${encodeURIComponent(id)}`)
  if (!res.ok) throw new Error('Could not load the invitation')
  return (await res.json()) as InvitationPreview
}
