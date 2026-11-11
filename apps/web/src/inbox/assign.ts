// The member picker (A) and the assignee views: which items they list.
import type { Call, WorkspaceMember } from '@linedesk/db/types'
import { memberLabel } from '../team/members.ts'
import type { CommandGroup, CommandItem } from '../ui/CommandMenu.tsx'

export type AssignPick = CommandItem & { userId: string | null }

/**
 * Who the calls can go to: you first, then the team by name; "No one" when any of them has someone.
 * The member the calls already have is marked.
 */
export function assignGroups(members: WorkspaceMember[], me: string, calls: Call[]): CommandGroup<AssignPick>[] {
  const current = new Set(calls.map(c => c.assignee_id))
  const only = current.size === 1 ? [...current][0] : undefined
  const person = (m: WorkspaceMember): AssignPick => ({
    label: memberLabel(m),
    avatar: memberLabel(m),
    userId: m.user_id,
    hint: [m.user_id === me && 'you', m.user_id === only && 'assigned'].filter(Boolean).join(' · ') || undefined,
    keywords: m.user_id === me ? 'me mine myself' : undefined,
  })
  const mine = members.filter(m => m.user_id === me)
  const others = members.filter(m => m.user_id !== me)
  const nobody: AssignPick[] = [...current].some(Boolean)
    ? [{ label: 'No one', icon: 'close', userId: null, keywords: 'unassign nobody remove clear' }]
    : []
  return [{ label: null, items: [...mine.map(person), ...others.map(person), ...nobody] }]
}

export type AssigneeView = CommandItem & { tab: 'mine' | 'unassigned' | 'member'; member: string | null }

/** The assignee views: yours, nobody's, and each teammate's. */
export function assigneeViewGroups(members: WorkspaceMember[], me: string): CommandGroup<AssigneeView>[] {
  return [
    {
      label: null,
      items: [
        { label: 'Assigned to me', icon: 'user', tab: 'mine', member: null, shortcut: ['G', 'M'] },
        { label: 'Unassigned', icon: 'users', tab: 'unassigned', member: null, shortcut: ['G', 'U'], keywords: 'nobody no one' },
        ...members
          .filter(m => m.user_id !== me)
          .map((m): AssigneeView => ({ label: memberLabel(m), avatar: memberLabel(m), tab: 'member', member: m.user_id })),
      ],
    },
  ]
}
