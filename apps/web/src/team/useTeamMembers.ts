// The workspace's members, for assigning calls: loaded once per page and shared. Members are not in
// the local store (team-api.ts); a member who is not listed (yet) shows as "a teammate".
import type { TeamMember } from '@linedesk/actions'
import { useEffect, useState } from 'react'
import { teamApi } from './team-api.ts'

let loading: Promise<TeamMember[]> | null = null

export function useTeamMembers(): TeamMember[] {
  const [members, setMembers] = useState<TeamMember[]>([])
  useEffect(() => {
    let live = true
    loading ??= teamApi.list().then(
      data => data.members,
      () => {
        loading = null // try again on the next mount
        return []
      },
    )
    void loading.then(list => live && setMembers(list))
    return () => {
      live = false
    }
  }, [])
  return members
}

export const memberName = (members: TeamMember[], userId: string) => {
  const m = members.find(x => x.userId === userId)
  return m ? m.name || m.email : 'a teammate'
}
