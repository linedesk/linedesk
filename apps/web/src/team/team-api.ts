// Team actions run online against the API: members and invitations are not in the local store,
// and a role change or removal must not look done before the server has accepted it.
import type { AssignableRole, InvitationPreview, MemberEditData, TeamData, TeamLeaveData } from '@linedesk/actions'
import { fetchQuery, refreshQuery, useQuery } from '../cachedQuery.ts'
import { workspaceHeaders } from '../tabWorkspace.ts'
import { i18n } from '../i18n/index.tsx'

const TEAM = 'team'

async function runTeamAction<T = unknown>(name: string, input: object): Promise<T> {
  const res = await fetch(`/v1/actions/${name}`, {
    method: 'POST',
    credentials: 'include',
    headers: { ...workspaceHeaders(), 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
    body: JSON.stringify(input),
  })
  const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: string; code?: string; data?: T } | null
  // The code goes with the error: the leave dialog offers "Sign in again" on SIGN_IN_AGAIN.
  if (!res.ok || !body?.ok) throw Object.assign(new Error(body?.error ?? i18n().t('errors.generic')), { code: body?.code })
  return body.data as T
}

export const teamApi = {
  list: () => runTeamAction<TeamData>('team.list', {}),
  invite: (email: string, role: AssignableRole) => runTeamAction('team.invite', { email, role }),
  resend: (invitationId: string) => runTeamAction('team.resendInvite', { invitationId }),
  revoke: (invitationId: string) => runTeamAction('team.revokeInvite', { invitationId }),
  setRole: (memberId: string, role: AssignableRole) => runTeamAction('team.setRole', { memberId, role }),
  /** The owner hands the workspace over: the member becomes the owner, the owner an admin. */
  transferOwnership: (memberId: string) => runTeamAction('team.transferOwnership', { memberId }),
  /** `deleteAccount` (the owner only): also delete their account when this was their last workspace. */
  remove: (memberId: string, deleteAccount = false) =>
    // keepAccount says the same for an API one release older, which reads a missing keepAccount as "delete" (LIN-264
    // review F2): a deploy or rollback window must never turn a plain removal into an account delete. keepAccount can
    // be dropped here (and from the action's input) after the next release, v0.1.14.
    runTeamAction('team.removeMember', { memberId, deleteAccount, keepAccount: !deleteAccount }),
  /**
   * `deleteAccount`: true deletes the account when this was its last workspace (never a server admin's); it needs a
   * sign-in in the last 10 minutes, else the error has `code` SIGN_IN_AGAIN.
   */
  leave: (deleteAccount: boolean) => runTeamAction<TeamLeaveData>('team.leave', { deleteAccount }),
  /** A teammate's profile and notifications, for the Edit dialog (owners and admins). */
  getMember: (memberId: string) => runTeamAction<MemberEditData>('team.getMember', { memberId }),
  setMemberNotifications: (memberId: string, change: object) =>
    runTeamAction('team.updateMemberNotifications', { memberId, ...change }),
}

/** Members and invitations: the last known at once (also across page loads), refreshed in the background. Shared by the Team page and call assignment. */
export const useTeam = () => useQuery(TEAM, teamApi.list, { persist: true })
/** After a change outside the Team page that the list shows (your own name): the list has it at once. */
export const refreshTeam = () => refreshQuery(TEAM)
/** Loads the team ahead, at app start: the Team page and call assignment then open with it. */
export const preloadTeam = () => fetchQuery(TEAM, teamApi.list, { persist: true })

export async function previewInvitation(id: string): Promise<InvitationPreview> {
  const res = await fetch(`/v1/invitations/${encodeURIComponent(id)}`)
  // A code, not words: the invitation page says it through authErrorMessage like every sign-in error.
  if (!res.ok)
    throw Object.assign(new Error('invitation unavailable'), { code: 'INVITATION_UNAVAILABLE', status: res.status })
  return (await res.json()) as InvitationPreview
}
