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
  // A partner team's membership changes only with that team (docs/white-label.md; the API says partner_managed).
  return data.canManage && m.role !== 'owner' && m.userId !== data.me && !m.partner
}
/** The roles the role menu offers for a teammate: Owner only to the owner (it hands the workspace over). */
export const rolesFor = (data: TeamData) => (isOwner(data) ? teamRoles : assignableRoles)
/**
 * The team as this tab shows it. During support access (an instance admin signed in as the person) nothing on it can
 * be changed (apps/api/src/impersonation-guard.ts): it reads as a member's view, the invitations still listed.
 */
export const teamAsShown = (data: TeamData | null, supportAccess: boolean): TeamData | null =>
  data && supportAccess ? { ...data, canManage: false } : data

export const canRemove = (data: TeamData, m: TeamMember) =>
  data.canManage && m.role !== 'owner' && m.userId !== data.me && !m.partner

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
  // Someone here through the workspace's partner keeps their own name, picture and notifications: their account is the
  // partner's person in every client workspace, and the partner manages their access (docs/white-label.md).
  data.canManage && m.userId !== data.me && (m.role !== 'owner' || isOwner(data)) && !m.partner

/**
 * The members as the Team page lists them: the workspace's own people first, its owner at the top, then the people here
 * through its white-label partner; otherwise in the server's order.
 */
export const membersInOrder = (members: readonly TeamMember[]) => {
  const rank = (m: TeamMember) => (m.partner ? 2 : m.role === 'owner' ? 0 : 1)
  return [...members].sort((a, b) => rank(a) - rank(b))
}

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
 * Removing someone in Workspace settings › Team: their account stays by default; only the owner gets the box that
 * deletes it too when it is their only workspace (the server refuses it from anyone else; decision of 2026-11-15, LIN-264).
 * `run` gets whether the box is ticked: delete the account. `invitations`: how many pending invitations they sent to
 * this workspace; the removal cancels them (LIN-264 review F1).
 */
export function teamRemoveConfirmation(name: string, byOwner: boolean, invitations = 0) {
  const { t } = i18n()
  return {
    text: t('team.remove.text', { name, where: t('team.remove.thisWorkspace') }),
    list: [
      byOwner ? t('team.remove.ownerAccountStays') : t('team.remove.accountStays'),
      ...(invitations > 0 ? [t('team.remove.invitationsCanceled', { count: invitations })] : []),
    ],
    action: t('team.remove.action'),
    busyAction: t('team.remove.busy'),
    ...(byOwner ? { option: t('team.remove.deleteAccount') } : {}),
  }
}

/** How many pending invitations this person sent to the workspace (`team.list`; an older API sends no sender id: 0). */
export const sentInvitations = (data: TeamData, userId: string) =>
  data.invitations.filter(i => i.invitedById === userId).length

/**
 * Removing someone in Server admin: when it is their only workspace their account goes too, unless the box keeps it
 * (they then wait for an invitation). Server admins always keep theirs.
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

/** A team change run from the page: `done` is the toast on success. */
export type TeamRun = (work: () => Promise<unknown>, done: string, options?: { inDialog?: boolean }) => Promise<boolean>

/**
 * Runs team changes and reads the team again after each. Whether it went through: a failure is a toast, or, for a
 * change confirmed in a dialog (`inDialog`), thrown, so the dialog shows why and stays usable (LIN-266: a refused
 * removal left the Remove dialog stuck on "Removing…").
 */
export function teamRunner(toast: (text: string) => void, load: () => Promise<void>): TeamRun {
  return async (work, done, { inDialog = false } = {}) => {
    try {
      await work()
      toast(done)
      return true
    } catch (e) {
      if (inDialog) throw e
      toast(e instanceof Error ? e.message : String(e))
      return false
    } finally {
      await load()
    }
  }
}

/** The server refused because deleting an account needs a sign-in in the last 10 minutes (its SIGN_IN_AGAIN). */
export const needsSignInAgain = (err: unknown) =>
  typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'SIGN_IN_AGAIN'
