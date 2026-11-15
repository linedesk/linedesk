// The workspace's members from the local store (workspace_members: name, picture version, role; no emails),
// so assigning works at once and offline. Kept in step with the team by the server.
import { avatarUrlOf } from '@linedesk/actions'
import type { WorkspaceMember } from '@linedesk/db/types'
import { useMemo } from 'react'
import { useRows } from '../store.tsx'
import { i18n } from '../i18n/index.tsx'

/** Every member, by name; disabled accounts included (calls they had still show who). */
export function useMembers(): WorkspaceMember[] {
  const rows = useRows('workspace_members')
  return useMemo(() => [...rows].sort((a, b) => memberLabel(a).localeCompare(memberLabel(b))), [rows])
}

/** The members a call can be assigned to: not disabled. */
export function useAssignableMembers(): WorkspaceMember[] {
  const members = useMembers()
  return useMemo(() => members.filter(m => !m.disabled), [members])
}

export function useMember(userId: string | null): WorkspaceMember | undefined {
  const members = useRows('workspace_members')
  return userId ? members.find(m => m.user_id === userId) : undefined
}

/** A member's name; one without a name (or not synced yet) reads "A teammate". */
export const memberLabel = (m: Pick<WorkspaceMember, 'name'> | undefined) =>
  m?.name.trim() || i18n().t('team.invite.aTeammate')

/** A member's profile picture (Account settings › Profile), null without one: the initials show. */
export const memberAvatar = (m: Pick<WorkspaceMember, 'user_id' | 'avatar_version'> | undefined) =>
  m ? avatarUrlOf(m.user_id, m.avatar_version) : null

/** The first name, for short labels ("Assign to Sam"). */
export const firstName = (m: Pick<WorkspaceMember, 'name'> | undefined) => memberLabel(m).split(/\s+/)[0]!

/**
 * Assigning exists only once the workspace has a second member: alone there is nobody to hand a call
 * to, so every assign control, view and mark is hidden. Follows the members as they join or leave.
 */
export function useCanAssign(): boolean {
  return useAssignableMembers().length > 1
}
