// The workspace's members, for assigning calls: the Team page's cached list (team-api.ts useTeam).
// Members are not in the local store; a member who is not listed (yet) shows as "a teammate".
import type { TeamMember } from '@linedesk/actions'
import { useTeam } from './team-api.ts'

const NONE: TeamMember[] = []

export const useTeamMembers = (): TeamMember[] => useTeam().data?.members ?? NONE

export const memberName = (members: TeamMember[], userId: string) => {
  const m = members.find(x => x.userId === userId)
  return m ? m.name || m.email : 'a teammate'
}
