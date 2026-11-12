// What the Team page shows and offers, kept out of the component so it can be tested.
import type { TeamData, TeamInvitation, TeamMember } from '@linedesk/actions'

const DAY_MS = 86_400_000
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export const isEmail = (text: string) => EMAIL.test(text.trim())

export const roleLabel = (role: string) => role.charAt(0).toUpperCase() + role.slice(1)

/** The role in a sentence: "a member", "an admin", "an owner". */
export const roleInSentence = (role: string) => `${/^[aeiou]/i.test(role) ? 'an' : 'a'} ${role}`

export const isOwner = (data: TeamData) => data.members.some(m => m.userId === data.me && m.role === 'owner')
const ownerCount = (data: TeamData) => data.members.filter(m => m.role === 'owner').length

/**
 * Admins change admins and members; owners also make owners and change owners. Your own role only
 * when you are an owner and another owner remains (handing the workspace over). The last owner is
 * never demoted (the API refuses too). Nobody removes themselves from here (Leave workspace does).
 */
export function canEditRole(data: TeamData, m: TeamMember) {
  if (!data.canManage) return false
  if (m.role === 'owner' && (!isOwner(data) || ownerCount(data) < 2)) return false
  return m.userId !== data.me || (isOwner(data) && ownerCount(data) > 1)
}
export const canRemove = (data: TeamData, m: TeamMember) =>
  data.canManage && (m.role !== 'owner' || (isOwner(data) && ownerCount(data) > 1)) && m.userId !== data.me

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
  if (invite.expired) return 'Resend to renew the link'
  const days = Math.ceil((Date.parse(invite.expiresAt) - now) / DAY_MS)
  return days <= 1 ? 'Expires today' : `Expires in ${days} days`
}
