// Invitations to other workspaces, for someone who already has one: listed in the workspace menu,
// announced once by a toast, accepted or declined there. Memberships are not in the local store:
// the list is a cached read (last answer on the first frame, refreshed on open and focus), and
// joining reloads into the new workspace.
import type { MyInvitation } from '@linedesk/actions'
import { auth } from '../auth.ts'
import { fetchQuery, useQuery } from '../cachedQuery.ts'
import { expectSessionChange } from '../session.ts'
import { announceSwitch, workspaceHeaders } from '../tabWorkspace.ts'
import { i18n } from '../i18n/index.tsx'

async function runAction<T>(name: string, input: object): Promise<T> {
  const res = await fetch(`/v1/actions/${name}`, {
    method: 'POST',
    credentials: 'include',
    headers: { ...workspaceHeaders(), 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
    body: JSON.stringify(input),
  })
  const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: string; data?: T } | null
  if (!res.ok || !body?.ok) throw new Error(body?.error ?? i18n().t('errors.generic'))
  return body.data as T
}

/**
 * Makes a workspace active and reloads into it at `hash` (the inbox; null keeps the page): each
 * workspace has its own local store. The other tabs hear of it and say which workspace they are on.
 */
export async function switchToWorkspace(id: string, hash: string | null = '#calls') {
  const r = await auth.organization.setActive({ organizationId: id })
  if (r.error) throw new Error(r.error.message ?? i18n().t('shell.switcher.switchFailed'))
  announceSwitch(id)
  expectSessionChange() // the reload opens the new workspace, not the one this device remembers
  if (hash) window.location.hash = hash
  window.location.reload()
}

export async function joinWorkspace(invitationId: string) {
  const { workspaceId } = await runAction<{ workspaceId: string }>('invitation.accept', { invitationId })
  await switchToWorkspace(workspaceId)
}

export const declineInvitation = (invitationId: string) => runAction('invitation.decline', { invitationId })

const INVITATIONS_QUERY = 'invitations'
const NONE: MyInvitation[] = []
const loadInvitations = async () =>
  (await runAction<{ invitations: MyInvitation[] }>('invitation.listMine', {})).invitations

/** Load the invitations again: when the menu opens, after a decline. */
export const refreshInvitations = () => fetchQuery(INVITATIONS_QUERY, loadInvitations, { persist: true })

/** The pending invitations: the last known list at once, checked again in the background (mount, focus). */
export function useMyInvitations() {
  const query = useQuery(INVITATIONS_QUERY, loadInvitations, { persist: true })
  return { invitations: query.data ?? NONE, reload: refreshInvitations }
}

const SEEN_KEY = 'linedesk.seenInvitations'

/** Invitations this browser has not announced yet; marks them as announced. */
export function unannounced(list: MyInvitation[]): MyInvitation[] {
  let seen: string[] = []
  try {
    seen = JSON.parse(localStorage.getItem(SEEN_KEY) ?? '[]')
  } catch {
    seen = []
  }
  const fresh = list.filter(i => !seen.includes(i.invitationId))
  if (fresh.length) {
    try {
      localStorage.setItem(SEEN_KEY, JSON.stringify([...seen, ...fresh.map(i => i.invitationId)].slice(-50)))
    } catch {
      // Private mode: it is announced again next time.
    }
  }
  return fresh
}

/** "Owner", "Admin", "Member" in the active language; another role as it is, capitalized. */
export function roleLabel(role: string): string {
  const { t } = i18n()
  if (role === 'owner') return t('team.role.owner')
  if (role === 'admin') return t('team.role.admin')
  if (role === 'member') return t('team.role.member')
  return role.charAt(0).toUpperCase() + role.slice(1)
}

/** The toast for new invitations: one names the workspace, several are counted. */
export function invitationNotice(fresh: MyInvitation[]): string {
  if (fresh.length === 1)
    return i18n().t('shell.invitation.one', { name: fresh[0]!.invitedBy, workspace: fresh[0]!.workspaceName })
  return i18n().t('shell.invitation.many', { count: fresh.length })
}
