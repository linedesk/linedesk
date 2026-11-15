// What the Team page shows and offers, kept out of the component so it can be tested.
import {
  assignableRoles,
  type ChangedBy,
  type TeamData,
  type TeamInvitation,
  type TeamMember,
  teamRoles,
} from '@linedesk/actions'
import { fmt } from '../i18n/format.ts'
import { i18n } from '../i18n/index.tsx'

const DAY_MS = 86_400_000
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export const isEmail = (text: string) => EMAIL.test(text.trim())

export { roleLabel } from '../shell/invitations.ts'

/** The role in a sentence: "a member", "an admin", "an owner". */
export const roleInSentence = (role: string) => i18n().t('team.role.inSentence', { role })

/** The signed-in member's own row ("You"): it offers Edit profile. */
export const isMe = (data: TeamData, m: TeamMember) => m.userId === data.me
/** Where Edit profile goes: your name, in Account. */
export const PROFILE_HASH = '#account/profile'

export const isOwner = (data: TeamData) => data.members.some(m => m.userId === data.me && m.role === 'owner')

/**
 * A workspace has exactly one owner. Owners and admins change the role of admins and members (never their own, never
 * the owner's); the owner can also make one of them the owner (team.transferOwnership: they become an admin). The API
 * refuses the rest too. Nobody removes themselves from here (Leave workspace does).
 */
export function canEditRole(data: TeamData, m: TeamMember) {
  return data.canManage && m.role !== 'owner' && m.userId !== data.me
}
/** The roles the role menu offers for a teammate: Owner only to the owner (it hands the workspace over). */
export const rolesFor = (data: TeamData) => (isOwner(data) ? teamRoles : assignableRoles)
export const canRemove = (data: TeamData, m: TeamMember) => data.canManage && m.role !== 'owner' && m.userId !== data.me

export function isOnTeam(data: TeamData, email: string) {
  const address = email.trim().toLowerCase()
  return (
    data.members.some(m => m.email.toLowerCase() === address) ||
    data.invitations.some(i => i.email.toLowerCase() === address)
  )
}

export function joinedLabel(iso: string, now = new Date()) {
  const date = new Date(iso)
  const sameYear = date.getFullYear() === now.getFullYear()
  const day = fmt().dateTime(date, { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) })
  return i18n().t('team.member.joined', { date: day })
}

export function invitationStatus(invite: TeamInvitation, now = Date.now()) {
  const { t } = i18n()
  if (invite.expired) return t('team.invitation.renew')
  const days = Math.ceil((Date.parse(invite.expiresAt) - now) / DAY_MS)
  return days <= 1 ? t('team.invitation.expiresToday') : t('team.invitation.expiresIn', { days })
}

/**
 * Owners and admins edit a teammate (name, picture, notifications): not themselves (their own pages do that), and an
 * owner only when they are an owner too. The API checks the same.
 */
export const canEditMember = (data: TeamData, m: TeamMember) =>
  data.canManage && m.userId !== data.me && (m.role !== 'owner' || isOwner(data))

/** "Last changed by Ana Admin on Nov 14": on a member's own page, when someone else made the last change. */
export function changedByLabel(c: ChangedBy, now = new Date()) {
  const date = new Date(c.at)
  const sameYear = date.getFullYear() === now.getFullYear()
  const day = fmt().dateTime(date, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  })
  return i18n().t('team.changedBy', { name: c.name, date: day })
}

/**
 * Removing someone (Workspace settings › Team, Server admin): when it is their only workspace their account goes too,
 * unless the box keeps it (they then wait for an invitation). Server admins always keep theirs.
 */
export function removeMemberConfirmation(name: string, where?: string) {
  const { t } = i18n()
  const place = where ?? t('team.remove.thisWorkspace')
  return {
    text: t('team.remove.text', { name, where: place }),
    list: [t('team.remove.onlyWorkspace', { where: place })],
    action: t('team.remove.action'),
    busyAction: t('team.remove.busy'),
    option: t('team.remove.keepAccount'),
  }
}
