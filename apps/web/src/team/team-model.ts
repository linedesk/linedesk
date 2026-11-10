// What the Team page shows and offers, kept out of the component so it can be tested.
import type { TeamData, TeamInvitation, TeamMember } from '@callfront/actions'

const DAY_MS = 86_400_000
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export const isEmail = (text: string) => EMAIL.test(text.trim())

export const roleLabel = (role: string) => role.charAt(0).toUpperCase() + role.slice(1)

/**
 * Owners are shown, not edited: there is no ownership transfer yet, and the API refuses to demote
 * or remove the last owner. Nobody removes themselves from here.
 */
export const canEditRole = (data: TeamData, m: TeamMember) => data.canManage && m.role !== 'owner'
export const canRemove = (data: TeamData, m: TeamMember) => canEditRole(data, m) && m.userId !== data.me

export function isOnTeam(data: TeamData, email: string) {
  const address = email.trim().toLowerCase()
  return data.members.some(m => m.email.toLowerCase() === address) || data.invitations.some(i => i.email.toLowerCase() === address)
}

export function joinedLabel(iso: string, now = new Date()) {
  const date = new Date(iso)
  const sameYear = date.getFullYear() === now.getFullYear()
  return `Joined ${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) })}`
}

export function invitationStatus(invite: TeamInvitation, now = Date.now()) {
  if (invite.expired) return 'Expired'
  const days = Math.ceil((Date.parse(invite.expiresAt) - now) / DAY_MS)
  return days <= 1 ? 'Expires today' : `Expires in ${days} days`
}
