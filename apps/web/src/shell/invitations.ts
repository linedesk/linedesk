// Invitations to other workspaces, for someone who already has one: listed in the profile menu,
// announced once by a toast, accepted or declined there. Memberships are not in the local store:
// the list is a cached read (last answer on the first frame, refreshed on open and focus), and
// joining reloads into the new workspace.
import type { MyInvitation } from '@linedesk/actions'
import { auth } from '../auth.ts'
import { fetchQuery, useQuery } from '../cachedQuery.ts'

async function runAction<T>(name: string, input: object): Promise<T> {
  const res = await fetch(`/v1/actions/${name}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
    body: JSON.stringify(input),
  })
  const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: string; data?: T } | null
  if (!res.ok || !body?.ok) throw new Error(body?.error ?? 'That did not work. Try again.')
  return body.data as T
}

/** Makes a workspace active and reloads into it: each workspace has its own local store. */
export async function switchToWorkspace(id: string) {
  const r = await auth.organization.setActive({ organizationId: id })
  if (r.error) throw new Error(r.error.message ?? 'Could not switch the workspace')
  window.location.hash = '#calls'
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

export const roleLabel = (role: string) => role.charAt(0).toUpperCase() + role.slice(1)

/** The toast for new invitations: one names the workspace, several are counted. */
export function invitationNotice(fresh: MyInvitation[]): string {
  if (fresh.length === 1) return `${fresh[0]!.invitedBy} invited you to ${fresh[0]!.workspaceName}. Join from your profile in the menu.`
  return `You have ${fresh.length} invitations to other workspaces. Join from your profile in the menu.`
}
